// Package wallet provides deterministic HD wallet derivation for deposit addresses.
package wallet

import (
	"crypto/ecdsa"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
)

// Wallet derives child keys deterministically from a master seed.
type Wallet struct {
	masterKey []byte
}

// New creates a Wallet from a hex-encoded master seed.
// The seed must be at least 32 bytes (64 hex chars).
func New(seedHex string) (*Wallet, error) {
	seedHex = strings.TrimPrefix(seedHex, "0x")
	seedHex = strings.TrimPrefix(seedHex, "0X")

	seed, err := hex.DecodeString(seedHex)
	if err != nil {
		return nil, fmt.Errorf("decoding seed hex: %w", err)
	}

	if len(seed) < 32 {
		return nil, fmt.Errorf("seed must be at least 32 bytes, got %d", len(seed))
	}

	return &Wallet{masterKey: seed}, nil
}

// DerivePrivateKey derives a child private key for the given index.
// Derivation: privateKey = Keccak256(masterKey || bigEndian(index)).
func (w *Wallet) DerivePrivateKey(index int) (*ecdsa.PrivateKey, error) {
	buf := make([]byte, len(w.masterKey)+8)
	copy(buf, w.masterKey)
	binary.BigEndian.PutUint64(buf[len(w.masterKey):], uint64(index))

	childSeed := crypto.Keccak256(buf)
	key, err := crypto.ToECDSA(childSeed)
	if err != nil {
		return nil, fmt.Errorf("deriving key for index %d: %w", index, err)
	}

	return key, nil
}

// DeriveAddress derives the Ethereum address for the given index.
// Returns the EIP-55 checksummed address.
func (w *Wallet) DeriveAddress(index int) (string, error) {
	key, err := w.DerivePrivateKey(index)
	if err != nil {
		return "", err
	}

	addr := crypto.PubkeyToAddress(key.PublicKey)
	return addr.Hex(), nil
}
