CC      = gcc
E2FSPROGS = $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../e2fsprogs
CFLAGS  = -Wall -Wextra -O2 -g -I$(E2FSPROGS)/lib
LIBS    = $(E2FSPROGS)/lib/libext2fs.a $(E2FSPROGS)/lib/libcom_err.a
TARGET  = ext2opt
SRCS    = ext2opt.c
OBJS    = $(SRCS:.c=.o)

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(CFLAGS) -o $@ $^ $(LIBS)

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJS) $(TARGET)
