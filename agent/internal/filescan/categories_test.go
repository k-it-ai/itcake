package filescan

import (
	"testing"
	"time"
)

func TestMatchCategoryTempFiles(t *testing.T) {
	mats := []matcher{{id: categoryTempFiles, prefixes: []string{"/tmp/"}, minAge: 7 * 24 * time.Hour}}
	old := time.Now().Add(-30 * 24 * time.Hour)
	cat := matchCategory("/tmp/old.log", old, 1024, mats)
	if cat != categoryTempFiles {
		t.Errorf("want temp_files, got %q", cat)
	}
}

func TestMatchCategoryAgeGate(t *testing.T) {
	mats := []matcher{{id: categoryTempFiles, prefixes: []string{"/tmp/"}, minAge: 7 * 24 * time.Hour}}
	young := time.Now().Add(-1 * time.Hour)
	cat := matchCategory("/tmp/new.log", young, 1024, mats)
	if cat != "" {
		t.Errorf("want no match (too young), got %q", cat)
	}
}

func TestMatchCategoryUnrotatedLogsSizeGate(t *testing.T) {
	mats := []matcher{{id: categoryUnrotatedLogs, prefixes: []string{"/var/log/"}, minAge: 30 * 24 * time.Hour, minSize: 100 * 1024 * 1024}}
	old := time.Now().Add(-60 * 24 * time.Hour)
	if got := matchCategory("/var/log/syslog", old, 1024, mats); got != "" {
		t.Errorf("small log should not match: %q", got)
	}
	if got := matchCategory("/var/log/syslog", old, 200*1024*1024, mats); got != categoryUnrotatedLogs {
		t.Errorf("large unrotated log should match: %q", got)
	}
}

func TestMatchCategoryMissPrefix(t *testing.T) {
	mats := []matcher{{id: categoryTempFiles, prefixes: []string{"/tmp/"}}}
	if got := matchCategory("/etc/passwd", time.Now(), 1024, mats); got != "" {
		t.Errorf("/etc/passwd should not match temp: %q", got)
	}
}

func TestMatchCategoryContainsAll(t *testing.T) {
	mats := []matcher{{id: categoryBrowserCache, prefixes: []string{"/home/u/.cache/google-chrome/"}, containsAll: []string{"Cache"}}}
	hit := "/home/u/.cache/google-chrome/Default/Cache/cache_001"
	miss := "/home/u/.cache/google-chrome/Default/Bookmarks"
	if got := matchCategory(hit, time.Now(), 1024, mats); got != categoryBrowserCache {
		t.Errorf("want browser_cache, got %q", got)
	}
	if got := matchCategory(miss, time.Now(), 1024, mats); got != "" {
		t.Errorf("non-Cache subdir should miss: %q", got)
	}
}

func TestSystemPathDenylistContainsExpected(t *testing.T) {
	deny := systemPathDenylist()
	if len(deny) == 0 {
		t.Fatal("denylist must not be empty")
	}
}
