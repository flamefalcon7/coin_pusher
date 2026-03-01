// Package wallet provides BIP-32 HD wallet derivation for deposit addresses.
// Derivation path: m/44'/60'/0'/0/<index> (BIP-44 Ethereum standard).
package wallet

import (
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/btcsuite/btcd/btcutil/hdkeychain"
	"github.com/ethereum/go-ethereum/crypto"
)

// BIP-44 path components for Ethereum: m/44'/60'/0'/0
const (
	hardenedOffset = hdkeychain.HardenedKeyStart
	purposeIndex   = 44 + hardenedOffset
	coinTypeIndex  = 60 + hardenedOffset
	accountIndex   = 0 + hardenedOffset
	changeIndex    = 0
)

// Wallet derives child keys deterministically from a master seed using BIP-32.
type Wallet struct {
	accountKey *hdkeychain.ExtendedKey // m/44'/60'/0'/0
}

// New creates a Wallet from a hex-encoded master seed.
// The seed must be at least 32 bytes (64 hex chars).
// It derives the BIP-44 Ethereum account key (m/44'/60'/0'/0) eagerly.
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

	// BIP-32 master key from seed: HMAC-SHA512 with key "Bitcoin seed".
	masterKey, err := masterKeyFromSeed(seed)
	if err != nil {
		return nil, fmt.Errorf("generating master key: %w", err)
	}

	// Derive m/44'/60'/0'/0
	path := []uint32{purposeIndex, coinTypeIndex, accountIndex, changeIndex}
	key := masterKey
	for _, idx := range path {
		key, err = key.Derive(idx)
		if err != nil {
			return nil, fmt.Errorf("deriving path component %d: %w", idx, err)
		}
	}

	return &Wallet{accountKey: key}, nil
}

// masterKeyFromSeed generates a BIP-32 master key from seed bytes.
func masterKeyFromSeed(seed []byte) (*hdkeychain.ExtendedKey, error) {
	// HMAC-SHA512 with key "Bitcoin seed" per BIP-32 spec.
	h := hmac.New(sha512.New, []byte("Bitcoin seed"))
	h.Write(seed)
	lr := h.Sum(nil)

	secretKey := lr[:32]
	chainCode := lr[32:]

	parentFP := []byte{0x00, 0x00, 0x00, 0x00}
	version := []byte{0x04, 0x88, 0xAD, 0xE4} // xprv mainnet

	return hdkeychain.NewExtendedKey(version, secretKey, chainCode, parentFP, 0, 0, true), nil
}

// DerivePrivateKey derives a child private key for the given index.
// Derivation: m/44'/60'/0'/0/<index> (non-hardened child).
func (w *Wallet) DerivePrivateKey(index int) (*ecdsa.PrivateKey, error) {
	child, err := w.accountKey.Derive(uint32(index))
	if err != nil {
		return nil, fmt.Errorf("deriving key for index %d: %w", index, err)
	}

	ecPrivKey, err := child.ECPrivKey()
	if err != nil {
		return nil, fmt.Errorf("extracting EC private key for index %d: %w", index, err)
	}

	// Convert btcec private key bytes to go-ethereum ECDSA key.
	var privKeyBytes [32]byte
	ecPrivKey.Key.PutBytes(&privKeyBytes)

	key, err := crypto.ToECDSA(privKeyBytes[:])
	if err != nil {
		return nil, fmt.Errorf("converting to ECDSA for index %d: %w", index, err)
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
