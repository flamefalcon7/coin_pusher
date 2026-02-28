package ethereum

import (
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestTransferMethodID(t *testing.T) {
	t.Parallel()

	// transfer(address,uint256) selector = 0xa9059cbb
	got := hex.EncodeToString(TransferMethodID)
	if got != "a9059cbb" {
		t.Errorf("TransferMethodID = %s, want a9059cbb", got)
	}
}

func TestBalanceOfMethodID(t *testing.T) {
	t.Parallel()

	// balanceOf(address) selector = 0x70a08231
	got := hex.EncodeToString(BalanceOfMethodID)
	if got != "70a08231" {
		t.Errorf("BalanceOfMethodID = %s, want 70a08231", got)
	}
}

func TestEncodeTransfer(t *testing.T) {
	t.Parallel()

	to := common.HexToAddress("0x0000000000000000000000000000000000000001")
	amount := big.NewInt(1_000_000) // 1 USDC

	data := EncodeTransfer(to, amount)

	// Total length: 4 (selector) + 32 (address) + 32 (amount) = 68 bytes.
	if len(data) != 68 {
		t.Fatalf("calldata length = %d, want 68", len(data))
	}

	// First 4 bytes = transfer selector.
	selector := hex.EncodeToString(data[:4])
	if selector != "a9059cbb" {
		t.Errorf("selector = %s, want a9059cbb", selector)
	}

	// Bytes 4..36: address padded to 32 bytes (left-padded with zeros).
	addrBytes := data[4:36]
	// Last byte should be 0x01.
	if addrBytes[31] != 0x01 {
		t.Errorf("address last byte = %x, want 01", addrBytes[31])
	}
	// First 11 bytes should be zero (padding).
	for i := 0; i < 12; i++ {
		if addrBytes[i] != 0 {
			t.Errorf("address padding byte[%d] = %x, want 00", i, addrBytes[i])
		}
	}

	// Bytes 36..68: amount in uint256.
	amountBack := new(big.Int).SetBytes(data[36:68])
	if amountBack.Cmp(amount) != 0 {
		t.Errorf("amount = %s, want %s", amountBack, amount)
	}
}

func TestEncodeBalanceOf(t *testing.T) {
	t.Parallel()

	account := common.HexToAddress("0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B")
	data := EncodeBalanceOf(account)

	// Total length: 4 (selector) + 32 (address) = 36 bytes.
	if len(data) != 36 {
		t.Fatalf("calldata length = %d, want 36", len(data))
	}

	// First 4 bytes = balanceOf selector.
	selector := hex.EncodeToString(data[:4])
	if selector != "70a08231" {
		t.Errorf("selector = %s, want 70a08231", selector)
	}

	// Extract the address from the padded slot.
	addrFromData := common.BytesToAddress(data[4:36])
	if addrFromData != account {
		t.Errorf("address = %s, want %s", addrFromData.Hex(), account.Hex())
	}
}

func TestEncodeTransfer_LargeAmount(t *testing.T) {
	t.Parallel()

	to := common.HexToAddress("0xdead000000000000000000000000000000000000")
	// 1 billion USDC = 1e15 raw units (6 decimals)
	amount := new(big.Int).SetUint64(1_000_000_000_000_000)

	data := EncodeTransfer(to, amount)
	if len(data) != 68 {
		t.Fatalf("calldata length = %d, want 68", len(data))
	}

	amountBack := new(big.Int).SetBytes(data[36:68])
	if amountBack.Cmp(amount) != 0 {
		t.Errorf("amount = %s, want %s", amountBack, amount)
	}
}
