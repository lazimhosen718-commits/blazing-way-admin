package com.blazingway.superadmin;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

public class MainActivity extends Activity {
    private WebView web;
    private static final String ADMIN_HOST = "lazimhosen718-commits.github.io";
    private static final String ADMIN_URL = "https://" + ADMIN_HOST + "/blazing-way-admin/admin.html";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);

        web.setWebViewClient(new WebViewClient() {
            private boolean allowed(Uri uri) {
                if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
                String host = uri.getHost();
                return ADMIN_HOST.equals(host) || "www.googleapis.com".equals(host)
                    || "identitytoolkit.googleapis.com".equals(host)
                    || "securetoken.googleapis.com".equals(host);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (allowed(uri)) return false;
                if ("https".equalsIgnoreCase(uri.getScheme())) startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if (allowed(uri)) return false;
                if ("https".equalsIgnoreCase(uri.getScheme())) startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
        });
        setContentView(web);
        if (state == null) web.loadUrl(ADMIN_URL); else web.restoreState(state);
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }
    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}