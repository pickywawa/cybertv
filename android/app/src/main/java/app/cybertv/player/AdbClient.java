package app.cybertv.player;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

import javax.crypto.Cipher;

/**
 * Minimal ADB client over TCP (the "network debugging" of Android TVs, port 5555): connects,
 * authenticates with an RSA key (the TV asks once "Allow debugging?") and streams an APK to
 * `cmd package install`. No Android dependency, so it is also tested on a desktop JVM.
 *
 * Protocol: https://android.googlesource.com/platform/packages/modules/adb/+/HEAD/protocol.txt
 */
final class AdbClient implements AutoCloseable {
    private static final int A_CNXN = 0x4e584e43, A_AUTH = 0x48545541, A_OPEN = 0x4e45504f, A_OKAY = 0x59414b4f, A_CLSE = 0x45534c43, A_WRTE = 0x45545257;
    private static final int A_VERSION = 0x01000001;
    private static final int MAX_PAYLOAD = 256 * 1024;
    private static final int AUTH_TOKEN = 1, AUTH_SIGNATURE = 2, AUTH_RSAPUBLICKEY = 3;
    /** DigestInfo prefix of SHA-1: the token is signed as if it were a SHA-1 digest */
    private static final byte[] SHA1_PREFIX = {0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14};

    interface Listener {
        /** the TV shows "Allow debugging?": the user must accept it with the remote */
        void waitingForApproval();

        void uploaded(long sent, long total);
    }

    private final Socket sock;
    private final DataInputStream in;
    private final OutputStream out;
    private int maxData = 4096;
    private String banner = "";

    private AdbClient(Socket s) throws IOException {
        sock = s;
        in = new DataInputStream(s.getInputStream());
        out = s.getOutputStream();
    }

    /** a new RSA key pair (the TV remembers it once "Always allow" was ticked) */
    static KeyPair newKey() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        return g.generateKeyPair();
    }

    static String encode(KeyPair k) {
        return Base64.getEncoder().encodeToString(k.getPrivate().getEncoded()) + ":" + Base64.getEncoder().encodeToString(k.getPublic().getEncoded());
    }

    static KeyPair decode(String s) throws Exception {
        String[] p = s.split(":");
        KeyFactory f = KeyFactory.getInstance("RSA");
        PrivateKey priv = f.generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(p[0])));
        RSAPublicKey pub = (RSAPublicKey) f.generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(p[1])));
        return new KeyPair(pub, priv);
    }

    /** connects and authenticates; may wait (up to `approvalMs`) for the user to accept on the TV */
    static AdbClient connect(String host, int port, KeyPair key, String name, long approvalMs, Listener l) throws Exception {
        Socket s = new Socket();
        s.connect(new InetSocketAddress(host, port), 5000);
        s.setSoTimeout(15000);
        AdbClient c = new AdbClient(s);
        try {
            c.handshake(key, name, approvalMs, l);
            return c;
        } catch (Exception e) {
            c.close();
            throw e;
        }
    }

    String banner() {
        return banner;
    }

    private void handshake(KeyPair key, String name, long approvalMs, Listener l) throws Exception {
        send(A_CNXN, A_VERSION, MAX_PAYLOAD, "host::\0".getBytes(StandardCharsets.UTF_8));
        boolean signed = false;
        while (true) {
            Msg m = read();
            if (m.cmd == A_CNXN) {
                maxData = Math.max(4096, Math.min(m.arg1, MAX_PAYLOAD));
                banner = new String(m.data, StandardCharsets.UTF_8);
                return;
            }
            if (m.cmd != A_AUTH || m.arg0 != AUTH_TOKEN) throw new IOException("unexpected " + Integer.toHexString(m.cmd));
            if (!signed) {
                // a key the TV already trusts: the signature is enough
                send(A_AUTH, AUTH_SIGNATURE, 0, sign(key.getPrivate(), m.data));
                signed = true;
            } else {
                // unknown key: the TV asks the user (wait for their answer)
                send(A_AUTH, AUTH_RSAPUBLICKEY, 0, publicKeyBlob((RSAPublicKey) key.getPublic(), name));
                if (l != null) l.waitingForApproval();
                sock.setSoTimeout((int) approvalMs);
                Msg r = read();
                sock.setSoTimeout(15000);
                if (r.cmd != A_CNXN) throw new IOException("not approved");
                maxData = Math.max(4096, Math.min(r.arg1, MAX_PAYLOAD));
                banner = new String(r.data, StandardCharsets.UTF_8);
                return;
            }
        }
    }

    /** "device::ro.product.model=SHIELD Android TV;…" → "SHIELD Android TV" */
    String model() {
        int i = banner.indexOf("ro.product.model=");
        if (i < 0) return null;
        int j = banner.indexOf(';', i);
        return banner.substring(i + 17, j < 0 ? banner.length() : j);
    }

    /** streams the APK to the package manager; returns its answer ("Success" or the reason) */
    String install(File apk, Listener l) throws IOException {
        long size = apk.length();
        String out1 = installWith("exec:cmd package install -r -S " + size, apk, l);
        // very old systems: no "cmd package"
        if (out1.contains("Unknown command") || out1.contains("not found")) out1 = installWith("exec:pm install -r -S " + size, apk, l);
        return out1.trim();
    }

    private String installWith(String service, File apk, Listener l) throws IOException {
        int local = 1;
        send(A_OPEN, local, 0, (service + "\0").getBytes(StandardCharsets.UTF_8));
        Msg ok = read();
        if (ok.cmd == A_CLSE) throw new IOException("service refused");
        if (ok.cmd != A_OKAY) throw new IOException("unexpected " + Integer.toHexString(ok.cmd));
        int remote = ok.arg0;
        long total = apk.length(), sent = 0;
        ByteArrayOutputStream answer = new ByteArrayOutputStream();
        byte[] buf = new byte[maxData];
        try (InputStream f = new FileInputStream(apk)) {
            int n;
            while ((n = f.read(buf)) > 0) {
                byte[] chunk = n == buf.length ? buf : java.util.Arrays.copyOf(buf, n);
                send(A_WRTE, local, remote, chunk);
                // flow control: wait for the device's OKAY (it may write output meanwhile)
                while (true) {
                    Msg m = read();
                    if (m.cmd == A_OKAY) break;
                    if (m.cmd == A_WRTE) {
                        answer.write(m.data);
                        send(A_OKAY, local, remote, new byte[0]);
                    } else if (m.cmd == A_CLSE) {
                        return answer.toString("UTF-8");
                    }
                }
                sent += n;
                if (l != null) l.uploaded(sent, total);
            }
        }
        // the package manager installs, then writes its answer and closes
        sock.setSoTimeout(180000);
        while (true) {
            Msg m = read();
            if (m.cmd == A_WRTE) {
                answer.write(m.data);
                send(A_OKAY, local, remote, new byte[0]);
            } else if (m.cmd == A_CLSE) {
                send(A_CLSE, local, remote, new byte[0]);
                break;
            }
        }
        sock.setSoTimeout(15000);
        return answer.toString("UTF-8");
    }

    // ───────────────────────── wire ─────────────────────────

    private static final class Msg {
        int cmd, arg0, arg1;
        byte[] data;
    }

    private void send(int cmd, int arg0, int arg1, byte[] data) throws IOException {
        ByteBuffer h = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
        int sum = 0;
        for (byte b : data) sum += b & 0xff;
        h.putInt(cmd).putInt(arg0).putInt(arg1).putInt(data.length).putInt(sum).putInt(~cmd);
        out.write(h.array());
        out.write(data);
        out.flush();
    }

    private Msg read() throws IOException {
        byte[] head = new byte[24];
        in.readFully(head);
        ByteBuffer h = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN);
        Msg m = new Msg();
        m.cmd = h.getInt();
        m.arg0 = h.getInt();
        m.arg1 = h.getInt();
        int len = h.getInt();
        if (len < 0 || len > 16 * 1024 * 1024) throw new IOException("bad message");
        m.data = new byte[len];
        in.readFully(m.data);
        return m;
    }

    // ───────────────────────── keys ─────────────────────────

    private static byte[] sign(PrivateKey k, byte[] token) throws Exception {
        Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        c.init(Cipher.ENCRYPT_MODE, k);
        c.update(SHA1_PREFIX);
        c.update(token);
        return c.doFinal();
    }

    /** the public key in adb's own format (base64 of the mincrypt struct) + " name\0" */
    static byte[] publicKeyBlob(RSAPublicKey pub, String name) {
        int words = 2048 / 32;
        BigInteger n = pub.getModulus();
        BigInteger r32 = BigInteger.ONE.shiftLeft(32);
        BigInteger n0inv = r32.subtract(n.mod(r32).modInverse(r32));
        BigInteger rr = BigInteger.ONE.shiftLeft(4096).mod(n);
        ByteBuffer b = ByteBuffer.allocate(4 + 4 + 256 + 256 + 4).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(words);
        b.putInt(n0inv.intValue());
        b.put(littleEndian(n, 256));
        b.put(littleEndian(rr, 256));
        b.putInt(pub.getPublicExponent().intValue());
        String s = Base64.getEncoder().encodeToString(b.array()) + " " + name + "\0";
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] littleEndian(BigInteger v, int len) {
        byte[] be = v.toByteArray();
        byte[] le = new byte[len];
        for (int i = 0; i < len && i < be.length; i++) le[i] = be[be.length - 1 - i];
        return le;
    }

    @Override
    public void close() {
        try {
            sock.close();
        } catch (IOException ignored) {
        }
    }
}
