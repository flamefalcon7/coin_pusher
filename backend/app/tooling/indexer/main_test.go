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
			in:   "https://mainnet.base.org",
			want: []string{"https://mainnet.base.org"},
		},
		{
			name: "three URLs comma-separated",
			in:   "https://mainnet.base.org,https://alchemy.example.com,https://ankr.example.com",
			want: []string{"https://mainnet.base.org", "https://alchemy.example.com", "https://ankr.example.com"},
		},
		{
			name: "tolerates surrounding whitespace",
			in:   " https://a , https://b,  https://c ",
			want: []string{"https://a", "https://b", "https://c"},
		},
		{
			name: "drops empty entries and trailing comma",
			in:   "https://a,,https://b,",
			want: []string{"https://a", "https://b"},
		},
		{
			name: "empty input returns empty slice",
			in:   "",
			want: []string{},
		},
		{
			name: "all whitespace returns empty slice",
			in:   " , , ,",
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
