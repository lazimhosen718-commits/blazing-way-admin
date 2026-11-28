package com.blazingway.superadmin;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.content.Intent;
import android.net.Uri;

public class MainActivity extends Activity {
    private WebView web;
    private static final String ADMIN_URL = "https://lazimhosen718-commits.github.io/blazing-way-admin/admin.html";
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if ("https".equals(uri.getScheme()) && ("lazimhosen718-commits.github.io".equals(uri.getHost()) || "www.googleapis.com".equals(uri.getHost()) || "identitytoolkit.googleapis.com".equals(uri.getHost()) || "securetoken.googleapis.com".equals(uri.getHost()))) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        setContentView(web);
        if (state == null) web.loadUrl(ADMIN_URL); else web.restoreState(state);
    }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
