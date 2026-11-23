package app.cybertv.player;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * SPAKE2 over Ed25519, byte-for-byte the variant of BoringSSL (crypto/curve25519/spake25519.cc)
 * used by adb's pairing with a code (Android 11+ "wireless debugging"). Plain BigInteger
 * arithmetic: it runs once per pairing, speed does not matter.
 */
final class Spake2 {
    static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    /** order of the prime-order subgroup */
    static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
    private static final BigInteger D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
    private static final BigInteger I = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
    private static final BigInteger[] B;
    /** the fixed points of BoringSSL (hash of "edwards25519 point generation seed (M)" / "(N)") */
    static final BigInteger[] M = decode(hex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e"));
    static final BigInteger[] N = decode(hex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778"));

    static {
        BigInteger by = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
        B = new BigInteger[]{xrecover(by), by};
    }

    private final boolean alice;
    private final byte[] myName, theirName;
    private BigInteger privateKey, passwordScalar;
    private byte[] passwordHash, myMsg;

    /** names as adb passes them: "adb pair client" / "adb pair server" with their final NUL */
    Spake2(boolean alice, String myName, String theirName) {
        this.alice = alice;
        this.myName = (myName + "\0").getBytes(StandardCharsets.UTF_8);
        this.theirName = (theirName + "\0").getBytes(StandardCharsets.UTF_8);
    }

    byte[] generateMessage(byte[] password) throws Exception {
        byte[] r = new byte[64];
        new SecureRandom().nextBytes(r);
        // x25519_sc_reduce then ×8 (cofactor)
        privateKey = le(r).mod(L).shiftLeft(3);
        BigInteger[] pub = mul(B, privateKey);
        passwordHash = MessageDigest.getInstance("SHA-512").digest(password);
        BigInteger ps = le(passwordHash).mod(L);
        // BoringSSL's "password scalar hack": add l, 2l, 4l so the scalar is a multiple of 8
        if (ps.testBit(0)) ps = ps.add(L);
        if (ps.testBit(1)) ps = ps.add(L.shiftLeft(1));
        if (ps.testBit(2)) ps = ps.add(L.shiftLeft(2));
        passwordScalar = ps;
        BigInteger[] mask = mul(alice ? M : N, passwordScalar);
        myMsg = encode(add(pub, mask));
        return myMsg.clone();
    }

    /** the 64-byte shared key */
    byte[] processMessage(byte[] theirMsg) throws Exception {
        BigInteger[] qStar = decode(theirMsg);
        BigInteger[] peersMask = mul(alice ? N : M, passwordScalar);
        BigInteger[] q = add(qStar, neg(peersMask));
        byte[] dh = encode(mul(q, privateKey));
        MessageDigest sha = MessageDigest.getInstance("SHA-512");
        if (alice) {
            prefixed(sha, myName);
            prefixed(sha, theirName);
            prefixed(sha, myMsg);
            prefixed(sha, theirMsg);
        } else {
            prefixed(sha, theirName);
            prefixed(sha, myName);
            prefixed(sha, theirMsg);
            prefixed(sha, myMsg);
        }
        prefixed(sha, dh);
        prefixed(sha, passwordHash);
        return sha.digest();
    }

    private static void prefixed(MessageDigest sha, byte[] data) {
        long l = data.length;
        byte[] len = new byte[8];
        for (int i = 0; i < 8; i++) {
            len[i] = (byte) (l & 0xff);
            l >>>= 8;
        }
        sha.update(len);
        sha.update(data);
    }

    // ───────────────────────── Edwards25519 (affine, BigInteger) ─────────────────────────

    static BigInteger[] add(BigInteger[] a, BigInteger[] b) {
        BigInteger x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
        BigInteger t = D.multiply(x1).multiply(x2).multiply(y1).multiply(y2).mod(P);
        BigInteger x3 = x1.multiply(y2).add(x2.multiply(y1)).multiply(BigInteger.ONE.add(t).modInverse(P)).mod(P);
        BigInteger y3 = y1.multiply(y2).add(x1.multiply(x2)).multiply(BigInteger.ONE.subtract(t).mod(P).modInverse(P)).mod(P);
        return new BigInteger[]{x3, y3};
    }

    static BigInteger[] neg(BigInteger[] a) {
        return new BigInteger[]{P.subtract(a[0]).mod(P), a[1]};
    }

    static BigInteger[] mul(BigInteger[] pt, BigInteger e) {
        BigInteger[] q = {BigInteger.ZERO, BigInteger.ONE};
        for (int i = e.bitLength() - 1; i >= 0; i--) {
            q = add(q, q);
            if (e.testBit(i)) q = add(q, pt);
        }
        return q;
    }

    static byte[] encode(BigInteger[] pt) {
        byte[] out = toLe(pt[1], 32);
        if (pt[0].testBit(0)) out[31] |= (byte) 0x80;
        return out;
    }

    static BigInteger[] decode(byte[] s) {
        if (s.length != 32) throw new IllegalArgumentException("bad point");
        byte[] c = s.clone();
        boolean sign = (c[31] & 0x80) != 0;
        c[31] &= 0x7f;
        BigInteger y = le(c);
        BigInteger x = xrecover(y);
        if (x.testBit(0) != sign) x = P.subtract(x);
        BigInteger lhs = y.multiply(y).subtract(x.multiply(x)).subtract(BigInteger.ONE).subtract(D.multiply(x).multiply(x).multiply(y).multiply(y)).mod(P);
        if (lhs.signum() != 0) throw new IllegalArgumentException("point not on curve");
        return new BigInteger[]{x, y};
    }

    private static BigInteger xrecover(BigInteger y) {
        BigInteger xx = y.multiply(y).subtract(BigInteger.ONE).multiply(D.multiply(y).multiply(y).add(BigInteger.ONE).modInverse(P)).mod(P);
        BigInteger x = xx.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
        if (x.multiply(x).subtract(xx).mod(P).signum() != 0) x = x.multiply(I).mod(P);
        if (x.testBit(0)) x = P.subtract(x);
        return x;
    }

    static BigInteger le(byte[] b) {
        byte[] be = new byte[b.length + 1];
        for (int i = 0; i < b.length; i++) be[b.length - i] = b[i];
        return new BigInteger(be);
    }

    static byte[] toLe(BigInteger v, int len) {
        byte[] be = v.toByteArray();
        byte[] le = new byte[len];
        for (int i = 0; i < len && i < be.length; i++) le[i] = be[be.length - 1 - i];
        return le;
    }

    private static byte[] hex(String h) {
        byte[] o = new byte[h.length() / 2];
        for (int i = 0; i < o.length; i++) o[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return o;
    }
}
