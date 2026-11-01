package main

// Vault: every secret telegramd keeps on disk (the MTProto session, the
// update state with access hashes, the api_id/api_hash pair, later the bot
// token) is sealed with AES-256-GCM under one random key. The key lives in
// its own 0600 file (or comes from a systemd credential), so a copy of the
// state directory without the key is useless.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const vaultMagic = "TGD1"

type Vault struct {
	aead cipher.AEAD
}

// OpenVault loads the key from credPath (a systemd credential, read only) if
// it exists, else from keyPath, creating a fresh 32-byte key there (0600).
func OpenVault(keyPath, credPath string) (*Vault, error) {
	var key []byte
	if credPath != "" {
		if b, err := os.ReadFile(credPath); err == nil && len(b) >= 32 {
			key = b[:32]
		}
	}
	if key == nil {
		b, err := os.ReadFile(keyPath)
		switch {
		case err == nil && len(b) == 32:
			key = b
		case err == nil:
			return nil, fmt.Errorf("vault key %s has %d bytes, want 32", keyPath, len(b))
		case errors.Is(err, os.ErrNotExist):
			key = make([]byte, 32)
			if _, err := rand.Read(key); err != nil {
				return nil, err
			}
			if err := writeFileAtomic(keyPath, key); err != nil {
				return nil, err
			}
		default:
			return nil, err
		}
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Vault{aead: aead}, nil
}

// Seal encrypts plain; label is bound as additional data so a sealed session
// cannot be swapped in as sealed credentials.
func (v *Vault) Seal(label string, plain []byte) ([]byte, error) {
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	out := append([]byte(vaultMagic), nonce...)
	return v.aead.Seal(out, nonce, plain, []byte(label)), nil
}

func (v *Vault) Open(label string, sealed []byte) ([]byte, error) {
	ns := v.aead.NonceSize()
	if len(sealed) < len(vaultMagic)+ns || string(sealed[:len(vaultMagic)]) != vaultMagic {
		return nil, errors.New("vault: not a sealed file")
	}
	nonce := sealed[len(vaultMagic) : len(vaultMagic)+ns]
	plain, err := v.aead.Open(nil, nonce, sealed[len(vaultMagic)+ns:], []byte(label))
	if err != nil {
		return nil, errors.New("vault: cannot open (wrong key or damaged file)")
	}
	return plain, nil
}

// ReadSealed returns (nil, nil) when the file does not exist.
func (v *Vault) ReadSealed(path, label string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return v.Open(label, b)
}

func (v *Vault) WriteSealed(path, label string, plain []byte) error {
	b, err := v.Seal(label, plain)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, b)
}

// writeFileAtomic writes a 0600 file through a temp file and a rename.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".tmp-"+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
