// outline-helper: a userspace local-only SOCKS5+HTTP-CONNECT proxy that speaks
// ShadowSocks to an upstream server, optionally injecting a fixed salt prefix
// for DPI evasion (Outline-compatible).
//
// Drop-in replacement for sslocal's listener role, used by the extension only
// when the access key carries a `prefix_hex` value, or when a multihop chain
// is configured. Built from outline-sdk so the prefix mechanism matches what
// outline-ss-server expects.
//
// Multihop: when an entry hop is supplied (--entry-* flags), traffic is routed
// you -> entry -> exit -> target. outline-sdk dialers are composable, so the
// exit hop simply dials *through* the entry hop's StreamDialer instead of
// dialing TCP directly. The salt prefix is applied to the entry hop only,
// because that is the single ShadowSocks handshake visible to DPI on the local
// network; the inner exit handshake is already wrapped inside the entry tunnel.

package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Jigsaw-Code/outline-sdk/transport"
	"github.com/Jigsaw-Code/outline-sdk/transport/shadowsocks"
)

var version = "dev"

func main() {
	var (
		server          = flag.String("server", "", "Exit SS server host (required)")
		serverPort      = flag.Int("server-port", 0, "Exit SS server port (required)")
		cipher          = flag.String("cipher", "", "Exit SS cipher, e.g. chacha20-ietf-poly1305 (required)")
		password        = flag.String("password", "", "Exit SS password (required)")
		entryServer     = flag.String("entry-server", "", "Entry SS server host for multihop; empty disables multihop")
		entryServerPort = flag.Int("entry-server-port", 0, "Entry SS server port (required when --entry-server is set)")
		entryCipher     = flag.String("entry-cipher", "", "Entry SS cipher (required when --entry-server is set)")
		entryPassword   = flag.String("entry-password", "", "Entry SS password (required when --entry-server is set)")
		prefixHex       = flag.String("prefix-hex", "", "Hex-encoded salt prefix bytes; applied to the entry hop in multihop, else the single hop; empty disables prefix injection")
		socksAddr       = flag.String("socks-listen", "127.0.0.1:1080", "SOCKS5 listen address; empty disables SOCKS")
		httpAddr        = flag.String("http-listen", "", "HTTP CONNECT listen address; empty disables HTTP")
		showVersion     = flag.Bool("version", false, "Print version and exit")
	)
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	if *server == "" || *serverPort == 0 || *cipher == "" || *password == "" {
		log.Fatal("--server, --server-port, --cipher, --password are required")
	}
	if *socksAddr == "" && *httpAddr == "" {
		log.Fatal("at least one of --socks-listen / --http-listen must be set")
	}

	multihop := *entryServer != ""
	if multihop && (*entryServerPort == 0 || *entryCipher == "" || *entryPassword == "") {
		log.Fatal("--entry-server-port, --entry-cipher, --entry-password are required when --entry-server is set")
	}

	var prefix []byte
	if *prefixHex != "" {
		p, err := hex.DecodeString(*prefixHex)
		if err != nil {
			log.Fatalf("invalid --prefix-hex %q: %v", *prefixHex, err)
		}
		prefix = p
	}

	// Build the dialer chain. In multihop, the entry hop dials TCP directly and
	// carries the salt prefix (it is the only handshake on the local wire); the
	// exit hop then dials *through* the entry dialer. In single-hop, the exit
	// hop dials TCP directly and carries the prefix.
	var dialer transport.StreamDialer
	if multihop {
		entryDialer, err := newSSDialer(
			net.JoinHostPort(*entryServer, strconv.Itoa(*entryServerPort)),
			*entryCipher, *entryPassword, nil, prefix,
		)
		if err != nil {
			log.Fatalf("entry hop: %v", err)
		}
		exitDialer, err := newSSDialer(
			net.JoinHostPort(*server, strconv.Itoa(*serverPort)),
			*cipher, *password, entryDialer, nil,
		)
		if err != nil {
			log.Fatalf("exit hop: %v", err)
		}
		dialer = exitDialer
		log.Printf("multihop enabled: entry=%s:%d -> exit=%s:%d", *entryServer, *entryServerPort, *server, *serverPort)
	} else {
		d, err := newSSDialer(
			net.JoinHostPort(*server, strconv.Itoa(*serverPort)),
			*cipher, *password, nil, prefix,
		)
		if err != nil {
			log.Fatalf("stream dialer: %v", err)
		}
		dialer = d
	}
	if len(prefix) > 0 {
		log.Printf("salt prefix enabled: %d bytes hex=%s (applied to %s hop)", len(prefix), *prefixHex, hopLabel(multihop))
	} else {
		log.Printf("salt prefix disabled (plain SS handshake)")
	}

	if *socksAddr != "" {
		ln, err := net.Listen("tcp", *socksAddr)
		if err != nil {
			log.Fatalf("socks listen %s: %v", *socksAddr, err)
		}
		log.Printf("SOCKS5 listening on %s", *socksAddr)
		go serveSocks5(ln, dialer)
	}
	if *httpAddr != "" {
		ln, err := net.Listen("tcp", *httpAddr)
		if err != nil {
			log.Fatalf("http listen %s: %v", *httpAddr, err)
		}
		log.Printf("HTTP CONNECT listening on %s", *httpAddr)
		go serveHTTP(ln, dialer)
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	s := <-sigCh
	log.Printf("received %v, exiting", s)
}

// newSSDialer builds a ShadowSocks StreamDialer for one hop. When inner is nil
// the hop dials its server over plain TCP; otherwise it dials *through* inner
// (the previous hop's dialer), which is how the chain is composed. A non-empty
// prefix installs the Outline-compatible salt-prefix generator on this hop.
func newSSDialer(addr, cipher, password string, inner transport.StreamDialer, prefix []byte) (*shadowsocks.StreamDialer, error) {
	key, err := shadowsocks.NewEncryptionKey(cipher, password)
	if err != nil {
		return nil, fmt.Errorf("encryption key: %w", err)
	}
	var endpoint transport.StreamEndpoint
	if inner == nil {
		endpoint = &transport.TCPEndpoint{Address: addr}
	} else {
		endpoint = &transport.StreamDialerEndpoint{Dialer: inner, Address: addr}
	}
	dialer, err := shadowsocks.NewStreamDialer(endpoint, key)
	if err != nil {
		return nil, fmt.Errorf("stream dialer: %w", err)
	}
	if len(prefix) > 0 {
		dialer.SaltGenerator = shadowsocks.NewPrefixSaltGenerator(prefix)
	}
	return dialer, nil
}

func hopLabel(multihop bool) string {
	if multihop {
		return "entry"
	}
	return "single"
}

// ----- SOCKS5 (CONNECT only, no auth) ---------------------------------------

func serveSocks5(ln net.Listener, dialer transport.StreamDialer) {
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Printf("socks accept: %v", err)
			return
		}
		go handleSocks5(c, dialer)
	}
}

func handleSocks5(client net.Conn, dialer transport.StreamDialer) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(15 * time.Second))
	br := bufio.NewReader(client)

	header := make([]byte, 2)
	if _, err := io.ReadFull(br, header); err != nil {
		return
	}
	if header[0] != 0x05 {
		return
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(br, methods); err != nil {
		return
	}
	if _, err := client.Write([]byte{0x05, 0x00}); err != nil {
		return
	}

	req := make([]byte, 4)
	if _, err := io.ReadFull(br, req); err != nil {
		return
	}
	if req[0] != 0x05 {
		return
	}
	if req[1] != 0x01 {
		writeSocks5Reply(client, 0x07)
		return
	}

	var host string
	switch req[3] {
	case 0x01:
		b := make([]byte, 4)
		if _, err := io.ReadFull(br, b); err != nil {
			return
		}
		host = net.IP(b).String()
	case 0x03:
		lb := make([]byte, 1)
		if _, err := io.ReadFull(br, lb); err != nil {
			return
		}
		b := make([]byte, int(lb[0]))
		if _, err := io.ReadFull(br, b); err != nil {
			return
		}
		host = string(b)
	case 0x04:
		b := make([]byte, 16)
		if _, err := io.ReadFull(br, b); err != nil {
			return
		}
		host = net.IP(b).String()
	default:
		writeSocks5Reply(client, 0x08)
		return
	}
	pb := make([]byte, 2)
	if _, err := io.ReadFull(br, pb); err != nil {
		return
	}
	port := int(pb[0])<<8 | int(pb[1])
	target := net.JoinHostPort(host, strconv.Itoa(port))

	_ = client.SetDeadline(time.Time{})
	upstream, err := dialer.DialStream(context.Background(), target)
	if err != nil {
		log.Printf("socks dial %s: %v", target, err)
		writeSocks5Reply(client, 0x05)
		return
	}
	defer upstream.Close()
	if _, err := client.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	pipe(client, upstream)
}

func writeSocks5Reply(c net.Conn, code byte) {
	_, _ = c.Write([]byte{0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
}

// ----- HTTP CONNECT --------------------------------------------------------

func serveHTTP(ln net.Listener, dialer transport.StreamDialer) {
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Printf("http accept: %v", err)
			return
		}
		go handleHTTP(c, dialer)
	}
}

func handleHTTP(client net.Conn, dialer transport.StreamDialer) {
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(15 * time.Second))
	br := bufio.NewReader(client)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}
	if req.Method != http.MethodConnect {
		writeHTTPStatus(client, 405, "Only CONNECT supported")
		return
	}
	target := req.URL.Host
	if !strings.Contains(target, ":") {
		target += ":443"
	}
	_ = client.SetDeadline(time.Time{})
	upstream, err := dialer.DialStream(context.Background(), target)
	if err != nil {
		log.Printf("http dial %s: %v", target, err)
		writeHTTPStatus(client, 502, "Bad Gateway")
		return
	}
	defer upstream.Close()
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}
	pipe(client, upstream)
}

func writeHTTPStatus(c net.Conn, code int, msg string) {
	fmt.Fprintf(c, "HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", code, msg)
}

// ----- pipe ----------------------------------------------------------------

func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
	go func() { _, _ = io.Copy(b, a); done <- struct{}{} }()
	<-done
}
