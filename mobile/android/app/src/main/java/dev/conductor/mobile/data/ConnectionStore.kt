package dev.conductor.mobile.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.conductor.mobile.model.ConnectionConfig
import dev.conductor.mobile.model.ThemeMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.conductorDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "conductor_remote_prefs",
)

class ConnectionStore(private val context: Context) {
    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val BEARER_TOKEN = stringPreferencesKey("bearer_token")
        val THEME_MODE = stringPreferencesKey("theme_mode")
        val GROUP_TASKS_BY_PROJECT = booleanPreferencesKey("group_tasks_by_project")
    }

    val configFlow: Flow<ConnectionConfig> = context.conductorDataStore.data.map { prefs ->
        ConnectionConfig(
            serverUrl = prefs[Keys.SERVER_URL].orEmpty(),
            bearerToken = prefs[Keys.BEARER_TOKEN].orEmpty(),
        )
    }

    val themeModeFlow: Flow<ThemeMode> = context.conductorDataStore.data.map { prefs ->
        ThemeMode.fromStorageValue(prefs[Keys.THEME_MODE])
    }

    val groupTasksByProjectFlow: Flow<Boolean> = context.conductorDataStore.data.map { prefs ->
        prefs[Keys.GROUP_TASKS_BY_PROJECT] ?: false
    }

    suspend fun save(config: ConnectionConfig) {
        context.conductorDataStore.edit { prefs ->
            prefs[Keys.SERVER_URL] = config.serverUrl.trim().trimEnd('/')
            prefs[Keys.BEARER_TOKEN] = config.bearerToken.trim()
        }
    }

    suspend fun saveThemeMode(mode: ThemeMode) {
        context.conductorDataStore.edit { prefs ->
            prefs[Keys.THEME_MODE] = mode.storageValue
        }
    }

    suspend fun saveGroupTasksByProject(enabled: Boolean) {
        context.conductorDataStore.edit { prefs ->
            prefs[Keys.GROUP_TASKS_BY_PROJECT] = enabled
        }
    }

    suspend fun clear() {
        context.conductorDataStore.edit { prefs ->
            prefs.remove(Keys.SERVER_URL)
            prefs.remove(Keys.BEARER_TOKEN)
        }
    }
}
