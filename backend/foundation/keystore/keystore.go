// Package keystore provides RSA key management for JWT signing.
package keystore

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
)

// KeyStore manages a collection of RSA key pairs indexed by key ID.
type KeyStore struct {
	mu   sync.RWMutex
	keys map[string]*rsa.PrivateKey
}

// New constructs a KeyStore by loading all PEM files from the given filesystem.
// Each file's name (without extension) is used as the key ID.
func New(fsys fs.FS) (*KeyStore, error) {
	ks := &KeyStore{
		keys: make(map[string]*rsa.PrivateKey),
	}

	err := fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if filepath.Ext(path) != ".pem" {
			return nil
		}

		data, err := fs.ReadFile(fsys, path)
		if err != nil {
			return fmt.Errorf("read key %s: %w", path, err)
		}

		block, _ := pem.Decode(data)
		if block == nil {
			return fmt.Errorf("no PEM block found in %s", path)
		}

		key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return fmt.Errorf("parse key %s: %w", path, err)
		}

		kid := strings.TrimSuffix(filepath.Base(path), ".pem")
		ks.keys[kid] = key

		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk keys dir: %w", err)
	}

	return ks, nil
}

// PrivateKey returns the RSA private key for the given key ID.
func (ks *KeyStore) PrivateKey(kid string) (*rsa.PrivateKey, error) {
	ks.mu.RLock()
	defer ks.mu.RUnlock()

	key, ok := ks.keys[kid]
	if !ok {
		return nil, fmt.Errorf("key %q not found", kid)
	}

	return key, nil
}

// PublicKey returns the RSA public key for the given key ID.
func (ks *KeyStore) PublicKey(kid string) (*rsa.PublicKey, error) {
	key, err := ks.PrivateKey(kid)
	if err != nil {
		return nil, err
	}

	return &key.PublicKey, nil
}
