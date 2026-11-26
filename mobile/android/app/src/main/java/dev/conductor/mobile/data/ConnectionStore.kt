package dev.conductor.mobile.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.conductor.mobile.model.ConnectionConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.conductorDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "conductor_remote_prefs",
)

class ConnectionStore(private val context: Context) {
    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val BEARER_TOKEN = stringPreferencesKey("bearer_token")
    }

    val configFlow: Flow<ConnectionConfig> = context.conductorDataStore.data.map { prefs ->
        ConnectionConfig(
            serverUrl = prefs[Keys.SERVER_URL].orEmpty(),
            bearerToken = prefs[Keys.BEARER_TOKEN].orEmpty(),
        )
    }

    suspend fun save(config: ConnectionConfig) {
        context.conductorDataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = config.serverUrl.trim().trimEnd('/')
            prefs[Keys.BEARER_TOKEN] = config.bearerToken.trim()
        }
    }

    suspend fun clear() {
        context.conductorDataStore.edit { prefs ->
            prefs.remove(Keys.SERVER_URL)
            prefs.remove(Keys.BEARER_TOKEN)
        }
    }
}
