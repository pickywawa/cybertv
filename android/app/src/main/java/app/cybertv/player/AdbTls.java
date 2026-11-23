package app.cybertv.player;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * TLS for adb's "wireless debugging" (Android 11+): the phone presents a self-signed certificate
 * of its RSA key (the TV recognises the key it got when pairing); any TV certificate is accepted,
 * as adb itself does (trust comes from the pairing code, not from a CA).
 */
final class AdbTls {
    private AdbTls() {}

    static SSLContext context(KeyPair key) throws Exception {
        X509Certificate cert = selfSigned(key, "cyberiptv");
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        char[] pw = "adb".toCharArray();
        ks.setKeyEntry("adb", key.getPrivate(), pw, new Certificate[]{cert});
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, pw);
        TrustManager[] trustAll = {new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] c, String a) {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] c, String a) {
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        }};
        SSLContext ctx = SSLContext.getInstance("TLSv1.3");
        ctx.init(kmf.getKeyManagers(), trustAll, new SecureRandom());
        return ctx;
    }

    // ───────────────────────── minimal X.509 (DER) ─────────────────────────

    static X509Certificate selfSigned(KeyPair key, String cn) throws Exception {
        byte[] sigAlg = seq(oid(new int[]{1, 2, 840, 113549, 1, 1, 11}), new byte[]{0x05, 0x00});
        byte[] name = seq(set(seq(oid(new int[]{2, 5, 4, 3}), tlv(0x0c, cn.getBytes(StandardCharsets.UTF_8)))));
        long now = System.currentTimeMillis();
        byte[] validity = seq(time(new Date(now - 86400000L)), time(new Date(now + 20L * 365 * 86400000L)));
        byte[] serial = tlv(0x02, new BigInteger(63, new SecureRandom()).add(BigInteger.ONE).toByteArray());
        byte[] version = tlv(0xa0, tlv(0x02, new byte[]{2}));
        byte[] tbs = seq(version, serial, sigAlg, name, validity, name, key.getPublic().getEncoded());
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initSign(key.getPrivate());
        s.update(tbs);
        byte[] sig = s.sign();
        byte[] bits = new byte[sig.length + 1];
        System.arraycopy(sig, 0, bits, 1, sig.length);
        byte[] der = seq(tbs, sigAlg, tlv(0x03, bits));
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }

    private static byte[] time(Date d) {
        SimpleDateFormat f = new SimpleDateFormat("yyMMddHHmmss'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return tlv(0x17, f.format(d).getBytes(StandardCharsets.US_ASCII));
    }

    private static byte[] oid(int[] parts) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(parts[0] * 40 + parts[1]);
        for (int i = 2; i < parts.length; i++) {
            int v = parts[i];
            byte[] tmp = new byte[5];
            int n = 0;
            do {
                tmp[n++] = (byte) (v & 0x7f);
                v >>>= 7;
            } while (v != 0);
            for (int j = n - 1; j >= 0; j--) o.write(tmp[j] | (j > 0 ? 0x80 : 0));
        }
        return tlv(0x06, o.toByteArray());
    }

    private static byte[] seq(byte[]... parts) {
        return tlv(0x30, concat(parts));
    }

    private static byte[] set(byte[]... parts) {
        return tlv(0x31, concat(parts));
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (byte[] p : parts) o.write(p, 0, p.length);
        return o.toByteArray();
    }

    private static byte[] tlv(int tag, byte[] v) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(tag);
        int len = v.length;
        if (len < 0x80) o.write(len);
        else if (len < 0x100) {
            o.write(0x81);
            o.write(len);
        } else if (len < 0x10000) {
            o.write(0x82);
            o.write(len >> 8);
            o.write(len & 0xff);
        } else {
            o.write(0x83);
            o.write(len >> 16);
            o.write((len >> 8) & 0xff);
            o.write(len & 0xff);
        }
        o.write(v, 0, v.length);
        return o.toByteArray();
    }
}
