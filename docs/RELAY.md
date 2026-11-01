# SIP relay (bridge mode)

A SIP account (a landline or VoIP number from any provider that takes a SIP REGISTER) joins dsh-phone through a small Asterisk relay on the same machine as phone-hookd. In **bridge mode** the relay carries every call through a Twilio SIP Domain, so the SIP line gets the browser phone, voicemail with live transcript, pick up and do not disturb exactly like a Twilio number.

```
incoming:  caller -> SIP provider -> Asterisk (registered) -> Twilio SIP Domain
           -> {publicBaseUrl}/voice/sip (phone-hookd) -> browser or voicemail
outgoing:  browser -> Twilio -> <Dial><Sip> to the registered relay (X-Dest, X-Account, X-Bridge-Key)
           -> Asterisk checks the key -> SIP provider -> callee
```

The provider keeps every other registration of the same account (a desk phone, a router with a phone port), so all of them ring. **Ring other phones first** (`ringFirstSeconds`) lets them ring for a while before voicemail answers here: phone-hookd answers busy on the first pass when nothing would ring in the browser, and the relay asks again after that many seconds. Keep it shorter than any voicemail or call forwarding of the other phones.

## Install (Debian / Ubuntu)

1. `apt install asterisk` (22.x). Stop it, keep the package configs aside (`cp -a /etc/asterisk /etc/asterisk.dist-orig`), and replace them with the files in `deploy/asterisk/` (owner `root:asterisk`, mode 0640). They load only what the relay needs (PJSIP, G.711/G.722, the few dialplan apps it uses), keep AMI on 127.0.0.1, log security events to `security.log`, and use RTP ports 10000-10100.
2. Create the include directory for the generated files: `install -d -o YOUR_USER -g asterisk -m 2750 /etc/asterisk/dsh-phone` and let your user traverse `/etc/asterisk` (`chmod 0751 /etc/asterisk`).
3. Add `/etc/asterisk/dsh-phone` to `ReadWritePaths` of the phone-hookd unit (see `deploy/dsh-phone-hookd.service`), restart phone-hookd, then start Asterisk.
4. In Settings > Phone: a line with provider **SIP** and its number, a **SIP account** pointing at that line (the password in the account or in a `KEY=value` credentials file), **bridge via** your Twilio line, and the **relay** bind address (your LAN address, never 0.0.0.0) plus the public media address when the machine is behind NAT. Run **Apply to Twilio**: it creates the SIP Domain (`dsh-phone-<account>.sip.twilio.com`, Voice URL `{publicBaseUrl}/voice/sip`, SIP registration on), the credential list `dsh-phone-bridge` with one user, and maps it for registrations and calls. phone-hookd writes the Asterisk files and reloads over AMI.

phone-hookd regenerates the files on every settings change. Changing the transports (bind address or port, external addresses) needs `systemctl restart asterisk`; everything else reloads live.

## NAT

Signalling needs no port forward: both registrations are outbound, refreshed by OPTIONS keepalives, and the providers answer through the same mapping (`rport`, `rewrite_contact`). **Media does.** Twilio sends RTP to the address and port in the SDP and does not latch onto the source of the relay's packets (symmetric RTP), so behind a port-restricted NAT its audio never arrives. Forward UDP 10000-10100 on the router to the relay's LAN address (RTP only; nothing else listens there), or run the relay on a host with a public address. A router "SIP ALG" breaks the media too: it rewrites the SIP it can read and sends the RTP of those calls out from other ports. Set **Bridge transport: TLS** (`relay.bridgeTransport: tls`, port 5061, TLS 1.2 with the system CA bundle and server verification, SRTP SDES, and Secure media on the SIP Domain set by Apply): the ALG cannot read encrypted SIP, so the Twilio leg passes untouched. The next hop for TLS is the edge proxy `sip.<edge>.twilio.com:5061`, the name on Twilio's certificate. Calls placed from the browser make Twilio open its OWN TLS connection to the relay's registered Contact (it does not reuse the registration's connection). Behind NAT that needs a TLS listener with a certificate on a router-forwarded TCP port and a public Contact: `relay.tlsPort`, `relay.certFile` / `relay.keyFile`, `relay.tlsExternalAddress`, `relay.tlsExternalPort`. Restrict that port to Twilio's signalling ranges in the host firewall. A self-signed certificate was accepted by Twilio in testing. If the provider publishes two SIP ports (DNS SRV), `callPort` sends calls to the other one: a router ALG that drops INVITEs with SDP to 5060 is then bypassed. Some ALGs also mangle every INVITE that leaves the socket used for the registration; `callSourcePort` gives the account's calls (and keepalives) their own UDP socket while the registration stays where it is. The provider leg stays on its own transport (most residential providers have no TLS) and relies on the provider's NAT handling.

## Security

- SIP binds the LAN address and 127.0.0.1 only. Providers are identified by IP: the registrar host plus any extra provider IPs, and every Twilio SIP signalling range for the bridge. Anything else lands on the `anonymous` endpoint, whose context only hangs up (and logs `dsh-phone-security:`).
- Outgoing calls need the bridge key in `X-Bridge-Key`. The relay only stores its SHA-1 digest (salted) and compares digests, so the key itself is never on disk outside `~/.dsh/phone/relay.json` (0600) and the compare reveals nothing about it. Destinations must be E.164, inside the allowed prefixes (default: the account's own country) and outside the blocked prefixes (for example premium numbers).
- One call per SIP Call-ID: after a relay restart a provider may still hold the old registration for a while and fork the same call twice; the duplicate is dropped.
- The generated files hold the SIP passwords and the AMI secret (Asterisk must read them): mode 0640, group asterisk, in a 2750 directory. AMI is loopback only, one user with read `system`, write `system,config`.

## Server audio route (AudioSocket)

Calls placed with "Call audio: Via server" on a SIP line do not use the Twilio bridge: phone-hookd sends AMI `Originate` for `AudioSocket/127.0.0.1:<audio.audioSocketPort>/<uuid>` into the generated context `dshp-srv-<account>` (same allow / block prefixes and caller ID as `dshp-out-<account>`; it refuses any channel that is not AudioSocket), and Asterisk connects back to hookd's loopback AudioSocket listener. Requirements, all additive:

- `modules.conf`: `load => res_audiosocket.so` and `load => chan_audiosocket.so` (or `module load` both at runtime).
- The generated AMI user gets `read=system,call` (Dial and Hangup events of these calls) and `write=system,config,originate,call` (Originate, PlayDTMF for the keypad).
- No new listener on Asterisk's side and no change to the provider transports.
