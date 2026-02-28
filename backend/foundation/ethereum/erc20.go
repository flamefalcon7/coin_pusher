package ethereum

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// ERC-20 function selectors (first 4 bytes of keccak256 hash).
var (
	// transfer(address,uint256) = 0xa9059cbb
	TransferMethodID = crypto.Keccak256([]byte("transfer(address,uint256)"))[:4]

	// balanceOf(address) = 0x70a08231
	BalanceOfMethodID = crypto.Keccak256([]byte("balanceOf(address)"))[:4]
)

// EncodeTransfer builds the calldata for ERC-20 transfer(address,uint256).
func EncodeTransfer(to common.Address, amount *big.Int) []byte {
	data := make([]byte, 4+32+32)
	copy(data[0:4], TransferMethodID)
	copy(data[4+12:4+32], to.Bytes()) // address is left-padded to 32 bytes
	amount.FillBytes(data[4+32 : 4+64])
	return data
}

// EncodeBalanceOf builds the calldata for ERC-20 balanceOf(address).
func EncodeBalanceOf(account common.Address) []byte {
	data := make([]byte, 4+32)
	copy(data[0:4], BalanceOfMethodID)
	copy(data[4+12:4+32], account.Bytes())
	return data
}
