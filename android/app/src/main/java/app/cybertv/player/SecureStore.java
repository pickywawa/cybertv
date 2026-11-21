package app.cybertv.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** AES-256-GCM secrets, key kept in the Android Keystore (never leaves secure hardware when available). */
public class SecureStore {
    private static final String ALIAS = "cybertv.secure.v1";
    private static final String PREFS = "cybertv_secure";
    private final SharedPreferences prefs;

    public SecureStore(Context ctx) {
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    public void set(String k, String v) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(v.getBytes(StandardCharsets.UTF_8));
        ByteBuffer bb = ByteBuffer.allocate(1 + iv.length + ct.length);
        bb.put((byte) iv.length).put(iv).put(ct);
        prefs.edit().putString(k, Base64.encodeToString(bb.array(), Base64.NO_WRAP)).apply();
    }

    public String get(String k) {
        String s = prefs.getString(k, null);
        if (s == null) return null;
        try {
            ByteBuffer bb = ByteBuffer.wrap(Base64.decode(s, Base64.NO_WRAP));
            byte[] iv = new byte[bb.get()];
            bb.get(iv);
            byte[] ct = new byte[bb.remaining()];
            bb.get(ct);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return new String(c.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    public void remove(String k) {
        prefs.edit().remove(k).apply();
    }
}
