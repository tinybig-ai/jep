package dev.jep.client

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.jep.client.device.ThemeMode
import dev.jep.client.device.StreamService
import dev.jep.client.presentation.app.AppViewModel
import dev.jep.client.presentation.app.JepApp
import dev.jep.client.presentation.theme.JepTheme

// Composition root of the presentation side: one AppViewModel for the
// activity, screen VMs built per destination against its repository.
class MainActivity : ComponentActivity() {

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Insets must reach Compose: without edge-to-edge the decor consumes the
        // IME inset and the system no longer resizes for adjustResize (API 30+),
        // so imePadding() was a no-op and the keyboard sat over the composer and
        // the terminal. TopAppBar/Scaffold already handle the system bars.
        enableEdgeToEdge()
        ensureNotificationPermission()

        // the socket outlives screens; the service is what keeps it alive
        ContextCompat.startForegroundService(this, Intent(this, StreamService::class.java))
        setContent {
            val app: AppViewModel = viewModel()
            val prefs by app.prefs.collectAsState()
            JepTheme(
                darkTheme = when (prefs.theme) {
                    ThemeMode.DARK -> true
                    ThemeMode.LIGHT -> false
                    ThemeMode.SYSTEM -> isSystemInDarkTheme()
                },
            ) {
                Surface { JepApp(app) }
            }
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) return
        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
