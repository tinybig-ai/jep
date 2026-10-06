package dev.jep.client

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
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
import androidx.lifecycle.lifecycleScope
import dev.jep.client.domain.model.ThemeMode
import dev.jep.client.device.StreamService
import dev.jep.client.presentation.app.AppViewModel
import dev.jep.client.presentation.app.JepApp
import dev.jep.client.presentation.app.SharedContent
import dev.jep.client.presentation.theme.JepTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
        fileFrom(intent)
        pairFrom(intent)
        shareFrom(intent)

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
                textScale = prefs.textSize.scale,
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

    // Whether the person is looking at the app: the notification policy's
    // first question. Nothing ever answered it, so the service always believed
    // the app was away and announced a finished turn in the very chat on screen.
    override fun onStart() {
        super.onStart()
        dev.jep.client.device.AppPresence.onForeground()
    }

    override fun onStop() {
        dev.jep.client.device.AppPresence.onBackground()
        super.onStop()
    }

    /** a tap on a notification while the app is already running */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_SESSION)?.let { app.openSessionById(it) }
        fileFrom(intent)
        pairFrom(intent)
        shareFrom(intent)
    }

    /**
     * Something shared into jep from another app: text or a link, and/or
     * files. The file bytes are read here, in the activity that holds the
     * content grant — the ViewModel only ever sees bytes, so a revoked grant
     * can't starve a share that already landed.
     */
    private fun shareFrom(intent: Intent) {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
        if (!app.paired.value) return // nothing to share into without a gateway
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        lifecycleScope.launch {
            val files = withContext(Dispatchers.IO) {
                streamUris(intent).mapNotNull { uri ->
                    runCatching {
                        val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
                        SharedContent.SharedFile(nameFor(uri), bytes, contentResolver.getType(uri))
                    }.getOrNull()
                }
            }
            if (text.isNullOrBlank() && files.isEmpty()) return@launch
            app.offerShared(SharedContent(text, files))
        }
    }

    // EXTRA_STREAM is a single uri for SEND, a list for SEND_MULTIPLE
    @Suppress("DEPRECATION")
    private fun streamUris(intent: Intent): List<Uri> {
        val many = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        if (many != null) return many
        val single = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_STREAM)
        return listOfNotNull(single)
    }

    // a sender usually names its file; a bare content uri gets a safe fallback
    private fun nameFor(uri: Uri): String {
        runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (i >= 0 && c.moveToFirst()) c.getString(i)?.let { return it }
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "shared-${System.currentTimeMillis()}"
    }

    /**
     * A tapped relative link, rewritten to an address only this app answers.
     * The path is parked; whichever conversation is on screen takes it and
     * resolves it against its own workspace, which is the only thing that can
     * know what a relative path means.
     */
    private fun fileFrom(intent: Intent) {
        val data = intent.data ?: return
        if (data.scheme != "jep" || data.host != "file") return
        data.getQueryParameter("path")?.let { dev.jep.client.presentation.chat.OpenedFile.offer(it) }
    }

    /** a scanned pairing QR; ignored once paired, so a stray link can't move the app to another gateway */
    private fun pairFrom(intent: Intent) {
        val data = intent.data ?: return
        if (data.scheme != "jep" || data.host != "pair" || app.paired.value) return
        val address = data.getQueryParameter("address") ?: return
        val code = data.getQueryParameter("code") ?: return
        app.pair(address, code) { _, _ -> }
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
