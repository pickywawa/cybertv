package app.cybertv.player;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.interfaces.RSAPublicKey;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLSocket;

/**
 * adb pairing with a 6-digit code (Android 11+ "wireless debugging", AOSP adb/pairing_connection):
 *  1. TLS 1.3 to the pairing port, both sides with a certificate;
 *  2. SPAKE2 on code + 64 bytes exported from the TLS session (label "adb-label\0");
 *  3. each side sends its PeerInfo (here: this phone's adb public key), AES-128-GCM encrypted with
 *     a key derived (HKDF-SHA256) from the SPAKE2 secret. A wrong code fails at decryption.
 * Then the TV accepts TLS connections from this key on its "connect" port.
 */
final class AdbPairing {
    private static final int HEADER_VERSION = 1, SPAKE2_MSG = 0, PEER_INFO = 1;
    private static final int PEER_INFO_SIZE = 8192;

    /** exports the TLS keying material (android.net.ssl.SSLSockets on Android 12+) */
    interface Exporter {
        byte[] export(SSLSocket s, String label, int length) throws Exception;
    }

    static final class WrongCode extends IOException {
        WrongCode() {
            super("wrong pairing code");
        }
    }

    private AdbPairing() {}

    static void pair(String host, int port, String code, KeyPair key, String name, Exporter exporter) throws Exception {
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(host, port), 8000);
        raw.setSoTimeout(20000);
        try (SSLSocket ssl = (SSLSocket) AdbTls.context(key).getSocketFactory().createSocket(raw, host, port, true)) {
            ssl.setUseClientMode(true);
            ssl.setEnabledProtocols(new String[]{"TLSv1.3"});
            ssl.startHandshake();
            byte[] ekm = exporter.export(ssl, "adb-label\0", 64);
            byte[] codeBytes = code.trim().getBytes(StandardCharsets.UTF_8);
            byte[] password = new byte[codeBytes.length + ekm.length];
            System.arraycopy(codeBytes, 0, password, 0, codeBytes.length);
            System.arraycopy(ekm, 0, password, codeBytes.length, ekm.length);

            DataInputStream in = new DataInputStream(ssl.getInputStream());
            OutputStream out = ssl.getOutputStream();

            // SPAKE2
            Spake2 spake = new Spake2(true, "adb pair client", "adb pair server");
            byte[] msg = spake.generateMessage(password);
            write(out, SPAKE2_MSG, msg);
            byte[] theirMsg = read(in, SPAKE2_MSG);
            byte[] secret;
            try {
                secret = spake.processMessage(theirMsg);
            } catch (IllegalArgumentException e) {
                throw new WrongCode();
            }
            byte[] aesKey = hkdf(secret, "adb pairing_auth aes-128-gcm key".getBytes(StandardCharsets.UTF_8), 16);

            // our PeerInfo: type 0 (RSA public key) + adb's public key string
            byte[] info = new byte[PEER_INFO_SIZE];
            info[0] = 0;
            byte[] pub = AdbClient.publicKeyBlob((RSAPublicKey) key.getPublic(), name);
            System.arraycopy(pub, 0, info, 1, Math.min(pub.length, PEER_INFO_SIZE - 1));
            write(out, PEER_INFO, gcm(Cipher.ENCRYPT_MODE, aesKey, 0, info));

            // theirs: decrypting it proves both sides used the same code
            byte[] theirs;
            try {
                theirs = read(in, PEER_INFO);
            } catch (IOException e) {
                throw new WrongCode();
            }
            try {
                gcm(Cipher.DECRYPT_MODE, aesKey, 0, theirs);
            } catch (Exception e) {
                throw new WrongCode();
            }
        }
    }

    private static void write(OutputStream out, int type, byte[] payload) throws IOException {
        ByteBuffer h = ByteBuffer.allocate(6);
        h.put((byte) HEADER_VERSION).put((byte) type).putInt(payload.length); // big-endian size
        out.write(h.array());
        out.write(payload);
        out.flush();
    }

    private static byte[] read(DataInputStream in, int expected) throws IOException {
        byte[] h = new byte[6];
        in.readFully(h);
        ByteBuffer b = ByteBuffer.wrap(h);
        int version = b.get();
        int type = b.get();
        int len = b.getInt();
        if (version != HEADER_VERSION || type != expected || len < 0 || len > PEER_INFO_SIZE * 2) throw new IOException("bad pairing packet");
        byte[] p = new byte[len];
        in.readFully(p);
        return p;
    }

    /** AES-128-GCM, 12-byte nonce = the message counter (little-endian 64-bit) then zeros */
    private static byte[] gcm(int mode, byte[] key, long seq, byte[] data) throws Exception {
        byte[] nonce = new byte[12];
        for (int i = 0; i < 8; i++) nonce[i] = (byte) (seq >>> (8 * i));
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        return c.doFinal(data);
    }

    /** HKDF-SHA256 with no salt (RFC 5869) */
    static byte[] hkdf(byte[] ikm, byte[] info, int len) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(new byte[32], "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        byte[] out = new byte[len];
        byte[] t = new byte[0];
        int done = 0;
        for (int i = 1; done < len; i++) {
            mac.update(t);
            mac.update(info);
            mac.update((byte) i);
            t = mac.doFinal();
            int n = Math.min(t.length, len - done);
            System.arraycopy(t, 0, out, done, n);
            done += n;
        }
        return out;
    }
}
