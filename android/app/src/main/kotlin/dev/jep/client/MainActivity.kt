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
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import dev.jep.client.device.ThemeMode
import dev.jep.client.device.StreamService
import dev.jep.client.presentation.app.AppViewModel
import dev.jep.client.presentation.app.JepApp
import dev.jep.client.presentation.theme.JepTheme

// Composition root of the presentation side: one AppViewModel for the
// activity, screen VMs built per destination against its repository.
class MainActivity : ComponentActivity() {

    // held by the activity, not by setContent: a notification tapped while the
    // app is already up arrives through onNewIntent, which is outside composition
    private val app: AppViewModel by viewModels()

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

        // the socket outlives screens; the service is what keeps it alive —
        // unless the person has turned background streaming off, in which case
        // there is no service and therefore no notification
        if (dev.jep.client.device.AppSettings(getSharedPreferences("jep", MODE_PRIVATE)).backgroundStreaming) {
            ContextCompat.startForegroundService(this, Intent(this, StreamService::class.java))
        }
        setContent {
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
            // a cold start from a notification: after the first frame, so the
            // app is composed and the conversation can actually be opened
            LaunchedEffect(Unit) {
                intent?.getStringExtra(EXTRA_SESSION)?.let { app.openSessionById(it) }
            }
        }
    }

    /** a tap on a notification while the app is already running */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_SESSION)?.let { app.openSessionById(it) }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED
        ) return
        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    companion object {
        /** the conversation a notification was about */
        const val EXTRA_SESSION = "jep.session"
    }
}
