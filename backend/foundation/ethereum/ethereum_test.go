package ethereum

import (
	"crypto/ecdsa"
	"fmt"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

// signPersonal signs a message using EIP-191 personal_sign with v=27/28.
func signPersonal(key *ecdsa.PrivateKey, message string) (string, error) {
	prefixed := fmt.Sprintf("\x19Ethereum Signed Message:\n%d%s", len(message), message)
	hash := crypto.Keccak256Hash([]byte(prefixed))

	sig, err := crypto.Sign(hash.Bytes(), key)
	if err != nil {
		return "", err
	}

	// Convert v from 0/1 to 27/28 (MetaMask format).
	sig[64] += 27

	return "0x" + fmt.Sprintf("%x", sig), nil
}

func TestVerifyPersonalSign(t *testing.T) {
	t.Parallel()

	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}

	expectedAddr := crypto.PubkeyToAddress(key.PublicKey).Hex()

	msg := FormatLoginMessage("test-nonce-123")
	sig, err := signPersonal(key, msg)
	if err != nil {
		t.Fatalf("signing: %v", err)
	}

	recovered, err := VerifyPersonalSign(msg, sig)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}

	if !strings.EqualFold(recovered, expectedAddr) {
		t.Errorf("recovered = %s, want %s", recovered, expectedAddr)
	}
}

func TestVerifyPersonalSign_WrongMessage(t *testing.T) {
	t.Parallel()

	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generating key: %v", err)
	}

	expectedAddr := crypto.PubkeyToAddress(key.PublicKey).Hex()

	msg := FormatLoginMessage("nonce-1")
	sig, err := signPersonal(key, msg)
	if err != nil {
		t.Fatalf("signing: %v", err)
	}

	// Verify against a different message — should recover a different address.
	wrongMsg := FormatLoginMessage("nonce-2")
	recovered, err := VerifyPersonalSign(wrongMsg, sig)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}

	if strings.EqualFold(recovered, expectedAddr) {
		t.Error("wrong message should recover a different address")
	}
}

func TestVerifyPersonalSign_InvalidSig(t *testing.T) {
	t.Parallel()

	_, err := VerifyPersonalSign("hello", "0xdeadbeef")
	if err == nil {
		t.Error("expected error for invalid signature")
	}
}

func TestNormalizeAddress(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input   string
		want    string
		wantErr bool
	}{
		{
			input: "0xab5801a7d398351b8be11c439e05c5b3259aec9b",
			want:  "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
		},
		{
			input: "0xAB5801A7D398351B8BE11C439E05C5B3259AEC9B",
			want:  "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
		},
		{
			input:   "not-an-address",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()

			got, err := NormalizeAddress(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Error("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %s, want %s", got, tc.want)
			}
		})
	}
}

func TestFormatLoginMessage(t *testing.T) {
	t.Parallel()

	msg := FormatLoginMessage("abc123")
	if msg != "Sign in to Coin Pusher\nNonce: abc123" {
		t.Errorf("unexpected message: %q", msg)
	}
}
