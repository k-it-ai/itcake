//go:build linux

package reliability

import "testing"

func TestClassifyLinuxLine(t *testing.T) {
	cases := []struct {
		name string
		line string
		want lineClass
	}{
		{"empty", "", classNone},
		{"benign info", "May 06 10:00:00 host systemd[1]: Started Daily apt upgrade.", classNone},
		{"oom killer", "kernel: Out of memory: Killed process 1234 (firefox)", classCrash},
		{"oom kill verb", "Apr 11 12:00:00 host kernel: Killed process 999 (chrome) total-vm:..., oom-killer: enabled", classCrash},
		{"segfault", "kernel: app[123]: segfault at 0 ip 00007f...", classCrash},
		{"general protection fault", "kernel: traps: foo[1]: general protection fault: 0000", classCrash},
		{"kernel panic", "Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block", classCrash},
		{"systemd-coredump", "systemd-coredump[1234]: Process 5678 (foo) of user 1000 dumped core.", classCrash},
		{"hung task", "kernel: INFO: task kworker:1234 blocked for more than 120 seconds.", classHang},
		{"hung_task underscore", "kernel: hung_task: blocked tasks", classHang},
		{"soft lockup", "kernel: BUG: soft lockup - CPU#1 stuck for 22s!", classHang},
		{"systemd exit-code", "systemd[1]: nginx.service: Failed with result 'exit-code'.", classServiceFail},
		{"systemd timeout", "systemd[1]: my-app.service: Failed with result 'timeout'.", classServiceFail},
		{"service entered failed", "systemd[1]: foo.service: Service entered failed state.", classServiceFail},
		{"i/o error", "kernel: blk_update_request: I/O error, dev sda, sector 12345", classHardware},
		{"machine check", "kernel: mce: [Hardware Error]: Machine check events logged", classHardware},
		{"benign warning", "May 06 10:00:00 host kernel: warning: a thing happened", classNone},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := classifyLinuxLine(c.line)
			if got != c.want {
				t.Errorf("classifyLinuxLine(%q) = %d; want %d", c.line, got, c.want)
			}
		})
	}
}

func TestYesterdayFormat(t *testing.T) {
	d := yesterday()
	if len(d) != 10 || d[4] != '-' || d[7] != '-' {
		t.Errorf("yesterday() = %q; want YYYY-MM-DD", d)
	}
}
