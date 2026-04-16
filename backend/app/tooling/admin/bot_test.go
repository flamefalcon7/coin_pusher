// Smoke tests for `admin bot` subcommands.
//
// These cover the pure (DB-free) validation surface: dispatcher error
// reporting, config-value validation per key, referral-code generator shape,
// allowlist completeness, and helper formatting. Anything requiring real
// PostgreSQL (seed, list, stats, pause/resume, refill, config show/set
// success path) is covered by manual verification against a dev DB —
// integration coverage for those lives outside this unit-test file because
// the admin binary is the only consumer of this code path.
package main

import (
	"os"
	"strings"
	"testing"

	"github.com/flamefalcon/coin-pusher/backend/business/core/bot"
)

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

func TestBotCmd_NoSubcommand(t *testing.T) {
	withArgs(t, []string{"admin", "bot"}, func() {
		err := botCmd(nil)
		if err == nil {
			t.Fatal("expected error when subcommand missing, got nil")
		}
		if !strings.Contains(err.Error(), "usage:") {
			t.Errorf("error %q should mention usage", err)
		}
	})
}

func TestBotCmd_UnknownSubcommand(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "nope"}, func() {
		err := botCmd(nil)
		if err == nil {
			t.Fatal("expected error for unknown subcommand, got nil")
		}
		if !strings.Contains(err.Error(), "unknown bot subcommand") {
			t.Errorf("error %q should mention unknown subcommand", err)
		}
	})
}

func TestBotConfigCmd_NoSubcommand(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "config"}, func() {
		err := botConfigCmd(nil)
		if err == nil {
			t.Fatal("expected error when config subcommand missing, got nil")
		}
	})
}

func TestBotConfigCmd_UnknownSubcommand(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "config", "nope"}, func() {
		err := botConfigCmd(nil)
		if err == nil {
			t.Fatal("expected error for unknown config subcommand, got nil")
		}
	})
}

// ---------------------------------------------------------------------------
// kill-switch (validation only — no DB call until value passes)
// ---------------------------------------------------------------------------

func TestBotKillSwitch_RejectsMissingArg(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "kill-switch"}, func() {
		err := botKillSwitch(nil)
		if err == nil {
			t.Fatal("expected error when value missing")
		}
	})
}

func TestBotKillSwitch_RejectsInvalidValue(t *testing.T) {
	for _, v := range []string{"true", "ON", "0", "yes", ""} {
		withArgs(t, []string{"admin", "bot", "kill-switch", v}, func() {
			err := botKillSwitch(nil)
			if err == nil {
				t.Fatalf("expected error for kill-switch %q", v)
			}
			if !strings.Contains(err.Error(), "must be 'on' or 'off'") {
				t.Errorf("kill-switch %q: error %q should explain valid values", v, err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// pause / resume / refill — argument-shape errors
// ---------------------------------------------------------------------------

func TestBotPause_RejectsMissingArg(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "pause"}, func() {
		err := botPause(nil)
		if err == nil {
			t.Fatal("expected error when account_id missing")
		}
	})
}

func TestBotPause_RejectsBadUUID(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "pause", "not-a-uuid"}, func() {
		err := botPause(nil)
		if err == nil {
			t.Fatal("expected error for malformed uuid")
		}
	})
}

func TestBotResume_RejectsMissingArg(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "resume"}, func() {
		err := botResume(nil)
		if err == nil {
			t.Fatal("expected error when account_id missing")
		}
	})
}

func TestBotResume_RejectsBadUUID(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "resume", "not-a-uuid"}, func() {
		err := botResume(nil)
		if err == nil {
			t.Fatal("expected error for malformed uuid")
		}
	})
}

func TestBotRefill_RejectsMissingArgs(t *testing.T) {
	cases := [][]string{
		{"admin", "bot", "refill"},
		{"admin", "bot", "refill", "00000000-0000-0000-0000-000000000000"},
	}
	for _, args := range cases {
		withArgs(t, args, func() {
			err := botRefill(nil)
			if err == nil {
				t.Fatalf("expected error for args %v", args)
			}
		})
	}
}

func TestBotRefill_RejectsBadUUID(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "refill", "bad", "100"}, func() {
		err := botRefill(nil)
		if err == nil {
			t.Fatal("expected error for malformed uuid")
		}
	})
}

func TestBotRefill_RejectsBadAmount(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "refill",
		"00000000-0000-0000-0000-000000000000", "not-a-number"}, func() {
		err := botRefill(nil)
		if err == nil {
			t.Fatal("expected error for malformed amount")
		}
	})
}

func TestBotRefill_RejectsNonPositiveAmount(t *testing.T) {
	for _, amt := range []string{"0", "-100", "-0.01"} {
		withArgs(t, []string{"admin", "bot", "refill",
			"00000000-0000-0000-0000-000000000000", amt}, func() {
			err := botRefill(nil)
			if err == nil {
				t.Fatalf("expected error for amount %q", amt)
			}
			if !strings.Contains(err.Error(), "positive") {
				t.Errorf("amount %q: error %q should mention 'positive'", amt, err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// stats — duration parsing
// ---------------------------------------------------------------------------

func TestBotStats_RejectsBadDuration(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "stats", "--since", "not-a-duration"}, func() {
		err := botStats(nil)
		if err == nil {
			t.Fatal("expected error for malformed duration")
		}
		if !strings.Contains(err.Error(), "invalid --since") {
			t.Errorf("error %q should mention --since", err)
		}
	})
}

func TestBotStats_RejectsNonPositiveDuration(t *testing.T) {
	for _, d := range []string{"0s", "-1h", "-30m"} {
		withArgs(t, []string{"admin", "bot", "stats", "--since", d}, func() {
			err := botStats(nil)
			if err == nil {
				t.Fatalf("expected error for non-positive duration %q", d)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// config set — key + value validation
// ---------------------------------------------------------------------------

func TestBotConfigSet_RejectsUnknownKey(t *testing.T) {
	withArgs(t, []string{"admin", "bot", "config", "set", "no_such_key", "value"}, func() {
		err := botConfigSet(nil)
		if err == nil {
			t.Fatal("expected error for unknown key")
		}
		if !strings.Contains(err.Error(), "unknown config key") {
			t.Errorf("error %q should mention unknown key", err)
		}
	})
}

func TestBotConfigSet_RejectsMissingArgs(t *testing.T) {
	cases := [][]string{
		{"admin", "bot", "config", "set"},
		{"admin", "bot", "config", "set", "kill_switch"},
	}
	for _, args := range cases {
		withArgs(t, args, func() {
			err := botConfigSet(nil)
			if err == nil {
				t.Fatalf("expected error for args %v", args)
			}
		})
	}
}

func TestValidateConfigValue_KillSwitch(t *testing.T) {
	for _, v := range []string{"on", "off"} {
		if err := validateConfigValue(bot.ConfigKeyKillSwitch, v); err != nil {
			t.Errorf("kill_switch=%q rejected: %v", v, err)
		}
	}
	for _, v := range []string{"", "true", "ON", "1", "enabled"} {
		if err := validateConfigValue(bot.ConfigKeyKillSwitch, v); err == nil {
			t.Errorf("kill_switch=%q should be rejected", v)
		}
	}
}

func TestValidateConfigValue_Decimals(t *testing.T) {
	keys := []string{
		bot.ConfigKeyRefillAmount,
		bot.ConfigKeyRefillThreshold,
		bot.ConfigKeyDailyCap,
	}
	for _, k := range keys {
		// Valid positive decimals.
		for _, v := range []string{"1", "100", "0.01", "50000.5"} {
			if err := validateConfigValue(k, v); err != nil {
				t.Errorf("%s=%q rejected: %v", k, v, err)
			}
		}
		// Invalid: zero, negative, non-numeric.
		for _, v := range []string{"0", "-1", "not-a-number", "", "1.0e", "abc"} {
			if err := validateConfigValue(k, v); err == nil {
				t.Errorf("%s=%q should be rejected", k, v)
			}
		}
	}
}

func TestValidateConfigValue_CrowdScale(t *testing.T) {
	valid := []string{
		`{"0":3,"1":4,"2":4,"3":3,"4":3,"5":2}`,
		`{"0":0,"1":1}`, // zero values are allowed
		`{"10":99}`,
	}
	for _, v := range valid {
		if err := validateConfigValue(bot.ConfigKeyCrowdScale, v); err != nil {
			t.Errorf("crowd_scale=%q rejected: %v", v, err)
		}
	}

	invalid := []struct {
		val    string
		reason string
	}{
		{`not-json`, "not JSON"},
		{`{}`, "empty object"},
		{`{"0":-1}`, "negative value"},
		{`{"abc":3}`, "non-int key"},
		{`[1,2,3]`, "array, not object"},
		{`{"0":"three"}`, "non-int value"},
		{``, "empty string"},
	}
	for _, tc := range invalid {
		if err := validateConfigValue(bot.ConfigKeyCrowdScale, tc.val); err == nil {
			t.Errorf("crowd_scale=%q (%s) should be rejected", tc.val, tc.reason)
		}
	}
}

// ---------------------------------------------------------------------------
// allowlist completeness
// ---------------------------------------------------------------------------

// TestBotConfigAllowlist_MatchesConsts pins the allowlist to bot.ConfigKey*
// so a future const addition without a corresponding allowlist update is
// caught at test time rather than silently rejecting valid config writes.
func TestBotConfigAllowlist_MatchesConsts(t *testing.T) {
	expected := []string{
		bot.ConfigKeyKillSwitch,
		bot.ConfigKeyRefillAmount,
		bot.ConfigKeyRefillThreshold,
		bot.ConfigKeyDailyCap,
		bot.ConfigKeyCrowdScale,
	}
	if len(botConfigAllowedKeys) != len(expected) {
		t.Fatalf("allowlist has %d keys, expected %d (drift between bot.ConfigKey* and admin allowlist)",
			len(botConfigAllowedKeys), len(expected))
	}
	for _, k := range expected {
		if !botConfigAllowedKeys[k] {
			t.Errorf("allowlist missing key %q", k)
		}
	}
	// Every allowlisted key must have a validator that handles it.
	for k := range botConfigAllowedKeys {
		if err := validateConfigValue(k, "__sentinel__"); err == nil {
			t.Errorf("validator for %q accepts garbage sentinel — likely missing case", k)
		}
	}
}

func TestDefaultBotConfig_CoversAllAllowedKeys(t *testing.T) {
	for k := range botConfigAllowedKeys {
		val, ok := defaultBotConfig[k]
		if !ok {
			t.Errorf("defaultBotConfig missing key %q (seed would leave scheduler without a value)", k)
			continue
		}
		if err := validateConfigValue(k, val); err != nil {
			t.Errorf("default value for %q is invalid by validator: %v", k, err)
		}
	}
}

// ---------------------------------------------------------------------------
// referral-code generator shape
// ---------------------------------------------------------------------------

func TestGenerateBotReferralCode_Shape(t *testing.T) {
	const expectedPrefix = "bot-"
	const expectedLen = len(expectedPrefix) + 8

	seen := make(map[string]bool, 32)
	for i := 0; i < 32; i++ {
		code, err := generateBotReferralCode()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if !strings.HasPrefix(code, expectedPrefix) {
			t.Errorf("code %q missing prefix %q", code, expectedPrefix)
		}
		if len(code) != expectedLen {
			t.Errorf("code %q length=%d, want %d", code, len(code), expectedLen)
		}
		if seen[code] {
			t.Errorf("duplicate code %q in 32 samples (entropy concern)", code)
		}
		seen[code] = true
	}
}

// ---------------------------------------------------------------------------
// curated-name pool sanity
// ---------------------------------------------------------------------------

func TestCuratedDisplayNames_Count(t *testing.T) {
	if len(curatedDisplayNames) != 8 {
		t.Errorf("curatedDisplayNames has %d entries, plan specifies 8", len(curatedDisplayNames))
	}
	seen := make(map[string]bool, len(curatedDisplayNames))
	for _, n := range curatedDisplayNames {
		k := strings.ToLower(n)
		if seen[k] {
			t.Errorf("duplicate curated name %q (case-insensitive collision would force seed retry)", n)
		}
		seen[k] = true
	}
}

func TestBotSeedTotal_Is20(t *testing.T) {
	// Pinned by plan: 8 named + 12 anonymous = 20.
	if botSeedTotal != 20 {
		t.Errorf("botSeedTotal = %d, plan specifies 20", botSeedTotal)
	}
}

// ---------------------------------------------------------------------------
// truncate helper (defined in dlq.go, same package — make sure it's stable)
// ---------------------------------------------------------------------------

func TestTruncate(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 10, "short"},
		{"exactly10!", 10, "exactly10!"},
		{"way too long string here", 10, "way too l…"},
	}
	for _, tc := range cases {
		got := truncate(tc.in, tc.n)
		if got != tc.want {
			t.Errorf("truncate(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// withArgs swaps os.Args for the duration of fn. Captures + restores even on
// panic so a test failure doesn't leak args into a sibling test.
func withArgs(t *testing.T, args []string, fn func()) {
	t.Helper()
	saved := os.Args
	defer func() { os.Args = saved }()
	os.Args = args
	fn()
}
