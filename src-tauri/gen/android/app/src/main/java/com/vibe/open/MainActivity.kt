package com.vibe.open

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val density = webView.resources.displayMetrics.density

      fun toCssPx(px: Int): String {
        val dp = px / density
        return "${dp}px"
      }

      val js =
          """
          document.documentElement.style.setProperty('--safe-area-inset-top', '${toCssPx(bars.top)}');
          document.documentElement.style.setProperty('--safe-area-inset-bottom', '${toCssPx(bars.bottom)}');
          document.documentElement.style.setProperty('--safe-area-inset-left', '${toCssPx(bars.left)}');
          document.documentElement.style.setProperty('--safe-area-inset-right', '${toCssPx(bars.right)}');
          window.dispatchEvent(new Event('safe-area-insets-changed'));
          """
              .trimIndent()

      webView.post { webView.evaluateJavascript(js, null) }
      insets
    }
  }
}
