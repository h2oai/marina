/* Copyright 2025-2026 H2O.ai, Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Qualification only: intercept writes/sync to a disposable memory database
 * while its explicit fault marker exists. Never installed in the service.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int inject(int fd) {
  const char *root = getenv("MARINA_EIO_FIXTURE_DIR");
  if (!root || !strstr(root, "/marina-storage-drill-")) return 0;
  char marker[PATH_MAX], link[64], path[PATH_MAX];
  snprintf(marker, sizeof(marker), "%s/inject-eio", root);
  if (access(marker, F_OK) != 0) return 0;
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  ssize_t size = readlink(link, path, sizeof(path) - 1);
  if (size <= 0) return 0;
  path[size] = 0;
  size_t n = strlen(root);
  if (n >= sizeof(path) - 1) return 0;
  return strncmp(path, root, n) == 0 && path[n] == '/' && strstr(path + n, "memory.db") != NULL;
}
ssize_t pwrite(int fd, const void *buf, size_t count, off_t offset) {
  if (inject(fd)) { errno = EIO; return -1; }
  return ((ssize_t (*)(int, const void *, size_t, off_t))dlsym(RTLD_NEXT, "pwrite"))(fd, buf, count, offset);
}
ssize_t pwrite64(int fd, const void *buf, size_t count, off64_t offset) {
  if (inject(fd)) { errno = EIO; return -1; }
  return ((ssize_t (*)(int, const void *, size_t, off64_t))dlsym(RTLD_NEXT, "pwrite64"))(fd, buf, count, offset);
}
int fsync(int fd) {
  if (inject(fd)) { errno = EIO; return -1; }
  return ((int (*)(int))dlsym(RTLD_NEXT, "fsync"))(fd);
}
int fdatasync(int fd) {
  if (inject(fd)) { errno = EIO; return -1; }
  return ((int (*)(int))dlsym(RTLD_NEXT, "fdatasync"))(fd);
}
