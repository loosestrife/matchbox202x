CC = gcc
CFLAGS = -Wall -Wextra -O2 -fPIC -I.
LDFLAGS = -shared -ldl -lX11 -lm

all: libxoss.so xoss test_glquake_sim

libxoss.so: libxoss.c xoss_internal.h xoss_ioctl.h
	$(CC) $(CFLAGS) -shared -o $@ libxoss.c $(LDFLAGS)

xoss: xoss.c
	$(CC) $(CFLAGS) -o $@ xoss.c -lX11 -lm

test_glquake_sim: test_glquake_sim.c
	$(CC) $(CFLAGS) -o $@ test_glquake_sim.c -lm

clean:
	rm -f libxoss.so xoss test_glquake_sim *.o

.PHONY: all clean
