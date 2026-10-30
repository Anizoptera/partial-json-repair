// SPDX-License-Identifier: Apache-2.0

#include <libproc.h>
#include <stdint.h>
#include <sys/proc_info.h>

// Compile against the SDK layout instead of duplicating struct offsets in JavaScript.
uint64_t resident_bytes(int pid) {
    struct proc_taskinfo info;
    int size = sizeof(info);
    if (proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &info, size) != size) return 0;
    return info.pti_resident_size;
}
