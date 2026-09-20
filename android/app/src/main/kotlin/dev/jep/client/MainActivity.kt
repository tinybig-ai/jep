package dev.jep.client

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Surface
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.jep.client.presentation.app.AppViewModel
import dev.jep.client.presentation.app.JepApp
import dev.jep.client.presentation.theme.JepTheme

// Composition root of the presentation side: one AppViewModel for the
// activity, screen VMs built per destination against its repository.
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            JepTheme {
                Surface {
                    val app: AppViewModel = viewModel()
                    JepApp(app)
                }
            }
        }
    }
}
