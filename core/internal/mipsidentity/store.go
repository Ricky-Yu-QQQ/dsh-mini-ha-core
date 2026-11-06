package mipsidentity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

var ErrLegacy = errors.New("MIPS identity lacks renewal credentials; enroll it once with mips-enroll -upgrade")

func Load(path string) (Identity, error) {
	f, err := os.Open(path)
	if err != nil {
		return Identity{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Identity{}, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return Identity{}, errors.New("identity must be an owner-only regular file")
	}
	var id Identity
	if err := json.NewDecoder(f).Decode(&id); err != nil {
		return Identity{}, errors.New("invalid MIPS identity JSON")
	}
	if _, err := strconv.ParseUint(id.VirtualDID, 10, 64); err != nil {
		return Identity{}, errors.New("invalid MIPS virtual DID")
	}
	return id, nil
}

func SaveNew(path string, id Identity) error {
	return save(path, id, false)
}

func save(path string, id Identity, replace bool) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".identity-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	writeErr := json.NewEncoder(tmp).Encode(id)
	if err := errors.Join(writeErr, tmp.Sync(), tmp.Close()); err != nil {
		return err
	}
	var publishErr error
	if replace {
		publishErr = os.Rename(tmp.Name(), path)
	} else {
		publishErr = os.Link(tmp.Name(), path)
	}
	if publishErr != nil {
		return publishErr
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func update(path string, work func(Identity) (Identity, error)) (Identity, error) {
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return Identity{}, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return Identity{}, errors.New("another MIPS credential operation is running")
	}
	id, err := Load(path)
	if err != nil {
		return Identity{}, err
	}
	updated, err := work(id)
	if err != nil {
		return Identity{}, err
	}
	if updated != id {
		if err := save(path, updated, true); err != nil {
			return Identity{}, err
		}
	}
	return updated, nil
}

func Upgrade(ctx context.Context, client *http.Client, path, deviceID, code string) (Identity, error) {
	return update(path, func(id Identity) (Identity, error) {
		id.DeviceID = deviceID
		return Enroll(ctx, client, id, code)
	})
}

func Renew(ctx context.Context, client *http.Client, path string, now time.Time, force bool) (Identity, error) {
	return update(path, func(id Identity) (Identity, error) {
		expires, err := id.ExpiresAt()
		if err != nil {
			return Identity{}, err
		}
		if !force && now.Add(RenewBefore).Before(expires) {
			return id, nil
		}
		if id.RefreshToken == "" || id.UID == "" || id.DeviceID == "" {
			return Identity{}, ErrLegacy
		}
		token, err := exchange(ctx, client, id, map[string]any{"refresh_token": id.RefreshToken})
		if err != nil {
			return Identity{}, err
		}
		if token.RefreshToken != id.RefreshToken {
			id.RefreshToken = token.RefreshToken
			// The provider can invalidate the previous token before certificate signing.
			if err := save(path, id, true); err != nil {
				return Identity{}, err
			}
		}
		return sign(ctx, client, id, token.AccessToken)
	})
}
