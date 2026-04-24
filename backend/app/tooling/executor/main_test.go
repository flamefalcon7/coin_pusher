package main

import (
	"reflect"
	"testing"
)

func TestParseRPCURLs(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		in   string
		want []string
	}{
		{
			name: "single URL",
			in:   "https://alchemy.example.com",
			want: []string{"https://alchemy.example.com"},
		},
		{
			name: "two URLs (expected executor layout)",
			in:   "https://base-mainnet.g.alchemy.com/v2/key,https://rpc.ankr.com/base/key",
			want: []string{"https://base-mainnet.g.alchemy.com/v2/key", "https://rpc.ankr.com/base/key"},
		},
		{
			name: "tolerates whitespace",
			in:   " https://a , https://b ",
			want: []string{"https://a", "https://b"},
		},
		{
			name: "drops empties",
			in:   ",https://a,,https://b,",
			want: []string{"https://a", "https://b"},
		},
		{
			name: "empty returns empty",
			in:   "",
			want: []string{},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := parseRPCURLs(tc.in)
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseRPCURLs(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
