package wallet

import (
	"testing"
)

// Fixed test seed (64 hex chars = 32 bytes).
const testSeed = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

func TestNew(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		seed    string
		wantErr bool
	}{
		{name: "valid 32 bytes", seed: testSeed, wantErr: false},
		{name: "valid with 0x prefix", seed: "0x" + testSeed, wantErr: false},
		{name: "valid with 0X prefix", seed: "0X" + testSeed, wantErr: false},
		{name: "too short", seed: "deadbeef", wantErr: true},
		{name: "empty", seed: "", wantErr: true},
		{name: "invalid hex", seed: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := New(tc.seed)
			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestDeriveAddress_Deterministic(t *testing.T) {
	t.Parallel()

	w, err := New(testSeed)
	if err != nil {
		t.Fatalf("constructing wallet: %v", err)
	}

	// Derive the same index twice — must return identical address.
	addr1, err := w.DeriveAddress(0)
	if err != nil {
		t.Fatalf("first derivation: %v", err)
	}

	addr2, err := w.DeriveAddress(0)
	if err != nil {
		t.Fatalf("second derivation: %v", err)
	}

	if addr1 != addr2 {
		t.Fatalf("same seed+index produced different addresses:\n  first:  %s\n  second: %s", addr1, addr2)
	}
}

func TestDeriveAddress_DifferentIndices(t *testing.T) {
	t.Parallel()

	w, err := New(testSeed)
	if err != nil {
		t.Fatalf("constructing wallet: %v", err)
	}

	addr0, _ := w.DeriveAddress(0)
	addr1, _ := w.DeriveAddress(1)
	addr2, _ := w.DeriveAddress(2)

	if addr0 == addr1 || addr1 == addr2 || addr0 == addr2 {
		t.Fatalf("different indices must produce different addresses: %s, %s, %s", addr0, addr1, addr2)
	}
}

func TestDeriveAddress_Format(t *testing.T) {
	t.Parallel()

	w, err := New(testSeed)
	if err != nil {
		t.Fatalf("constructing wallet: %v", err)
	}

	addr, err := w.DeriveAddress(42)
	if err != nil {
		t.Fatalf("derivation: %v", err)
	}

	// Must be EIP-55 checksummed: 0x + 40 hex chars = 42 chars total.
	if len(addr) != 42 {
		t.Errorf("address length = %d, want 42", len(addr))
	}
	if addr[:2] != "0x" {
		t.Errorf("address should start with 0x, got %q", addr[:2])
	}
}

func TestDeriveAddress_BIP44GoldenVector(t *testing.T) {
	t.Parallel()

	// BIP-39 mnemonic: "abandon abandon abandon abandon abandon abandon
	//   abandon abandon abandon abandon abandon about"
	// Passphrase: "" (empty)
	// Seed produced by PBKDF2(mnemonic, "mnemonic"+passphrase).
	// This is the canonical test vector used by MetaMask, iancoleman BIP39
	// tool, and every major Ethereum wallet.
	// Expected addresses for m/44'/60'/0'/0/<index>.
	const bip39Seed = "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"

	w, err := New(bip39Seed)
	if err != nil {
		t.Fatalf("constructing wallet: %v", err)
	}

	// DO NOT change these expected values. They are the industry-standard
	// BIP-44 Ethereum addresses for the "abandon...about" mnemonic.
	// If this test fails, the derivation is broken.
	golden := []struct {
		index int
		addr  string
	}{
		{0, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"},
		{1, "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0"},
		{2, "0xb6716976A3ebe8D39aCEB04372f22Ff8e6802D7A"},
		{3, "0xF3f50213C1d2e255e4B2bAD430F8A38EEF8D718E"},
		{4, "0x51cA8ff9f1C0a99f88E86B8112eA3237F55374cA"},
	}

	for _, tc := range golden {
		addr, err := w.DeriveAddress(tc.index)
		if err != nil {
			t.Fatalf("index %d: %v", tc.index, err)
		}
		if addr != tc.addr {
			t.Errorf("index %d:\n  got:  %s\n  want: %s", tc.index, addr, tc.addr)
		}
	}
}

func TestDerivePrivateKey_Deterministic(t *testing.T) {
	t.Parallel()

	w, err := New(testSeed)
	if err != nil {
		t.Fatalf("constructing wallet: %v", err)
	}

	key1, err := w.DerivePrivateKey(5)
	if err != nil {
		t.Fatalf("first derivation: %v", err)
	}

	key2, err := w.DerivePrivateKey(5)
	if err != nil {
		t.Fatalf("second derivation: %v", err)
	}

	if key1.D.Cmp(key2.D) != 0 {
		t.Fatal("same seed+index produced different private keys")
	}
}

func TestDifferentSeeds_DifferentAddresses(t *testing.T) {
	t.Parallel()

	seed2 := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

	w1, _ := New(testSeed)
	w2, _ := New(seed2)

	addr1, _ := w1.DeriveAddress(0)
	addr2, _ := w2.DeriveAddress(0)

	if addr1 == addr2 {
		t.Fatal("different seeds must produce different addresses")
	}
}
