// telegramd: the Telegram half of dsh-phone. One Go process that holds
// the owner's Telegram account (MTProto via gotd/td) and talks only to
// phone-hookd over a private unix socket. It listens on no network port.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func defaultDir() string {
	if d := os.Getenv("DSH_TELEGRAM_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".dsh", "phone", "telegram")
}

func openRegular(p string) (*os.File, error) {
	st, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	return os.Open(p)
}

func main() {
	dir := flag.String("dir", defaultDir(), "state directory (0700)")
	sock := flag.String("sock", "", "unix socket path (default <dir>/telegramd.sock)")
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)
	syscall.Umask(0o077)

	cred := ""
	if cd := os.Getenv("CREDENTIALS_DIRECTORY"); cd != "" {
		cred = filepath.Join(cd, "telegramd.key")
	}
	p := MakePaths(*dir, *sock, cred)
	s, err := NewService(p)
	if err != nil {
		log.Fatalf("start: %v", err)
	}
	defer s.Close()

	_ = os.Remove(p.Sock)
	ln, err := net.Listen("unix", p.Sock)
	if err != nil {
		log.Fatalf("listen %s: %v", p.Sock, err)
	}
	_ = os.Chmod(p.Sock, 0o600)
	if cln, err := s.serveCallAudio(p.CallsSock); err != nil {
		log.Printf("call audio socket %s: %v (calls without audio)", p.CallsSock, err)
	} else {
		defer cln.Close()
	}
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go s.Run(ctx)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("serve: %v", err)
			stop()
		}
	}()
	log.Printf("telegramd %s listening on %s (state %s)", version, p.Sock, p.Dir)
	<-ctx.Done()
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
	_ = os.Remove(p.Sock)
	log.Printf("telegramd stopped")
}
