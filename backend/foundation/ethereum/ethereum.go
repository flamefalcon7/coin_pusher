// Package ethereum provides EVM signature verification utilities.
package ethereum

import (
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// FormatLoginMessage builds the canonical sign-in message for a given nonce.
func FormatLoginMessage(nonce string) string {
	return "Sign in to Coin Pusher\nNonce: " + nonce
}

// FormatWithdrawMessage builds the canonical withdrawal message that the user
// must sign via personal_sign. The message binds to_address + amount + nonce
// so the signature cannot be reused for a different withdrawal.
func FormatWithdrawMessage(nonce, toAddress, amount string) string {
	return "Coin Pusher Withdraw\nTo: " + toAddress + "\nAmount: " + amount + " USDC\nNonce: " + nonce
}

// VerifyPersonalSign recovers the signer address from an EIP-191 personal_sign
// signature. It returns the EIP-55 checksummed address on success.
func VerifyPersonalSign(message, sigHex string) (string, error) {
	sig, err := decodeHex(sigHex)
	if err != nil {
		return "", fmt.Errorf("decoding signature: %w", err)
	}

	if len(sig) != 65 {
		return "", fmt.Errorf("invalid signature length: %d", len(sig))
	}

	// EIP-191: "\x19Ethereum Signed Message:\n" + len(message) + message
	prefixed := fmt.Sprintf("\x19Ethereum Signed Message:\n%d%s", len(message), message)
	hash := crypto.Keccak256Hash([]byte(prefixed))

	// Normalize v value: MetaMask and others use v=27/28, ecrecover needs 0/1.
	if sig[64] >= 27 {
		sig[64] -= 27
	}

	pubKey, err := crypto.Ecrecover(hash.Bytes(), sig)
	if err != nil {
		return "", fmt.Errorf("ecrecover: %w", err)
	}

	pub, err := crypto.UnmarshalPubkey(pubKey)
	if err != nil {
		return "", fmt.Errorf("unmarshal pubkey: %w", err)
	}

	addr := crypto.PubkeyToAddress(*pub)
	return addr.Hex(), nil
}

// NormalizeAddress returns the EIP-55 checksummed form of an Ethereum address.
func NormalizeAddress(address string) (string, error) {
	if !common.IsHexAddress(address) {
		return "", fmt.Errorf("invalid ethereum address: %s", address)
	}
	return common.HexToAddress(address).Hex(), nil
}

// decodeHex decodes a hex string with or without "0x" prefix.
func decodeHex(s string) ([]byte, error) {
	s = strings.TrimPrefix(s, "0x")
	s = strings.TrimPrefix(s, "0X")
	return hex.DecodeString(s)
}
