package dev.conductor.mobile

import dev.conductor.mobile.model.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Test

class ThemeModeTest {
    @Test
    fun parsesStorageValuesCaseInsensitively() {
        assertEquals(ThemeMode.SYSTEM, ThemeMode.fromStorageValue("system"))
        assertEquals(ThemeMode.LIGHT, ThemeMode.fromStorageValue("light"))
        assertEquals(ThemeMode.LIGHT, ThemeMode.fromStorageValue("LIGHT"))
        assertEquals(ThemeMode.DARK, ThemeMode.fromStorageValue("dark"))
        assertEquals(ThemeMode.DARK, ThemeMode.fromStorageValue("  Dark  "))
    }

    @Test
    fun fallsBackToSystemForNullOrUnknownValues() {
        assertEquals(ThemeMode.SYSTEM, ThemeMode.fromStorageValue(null))
        assertEquals(ThemeMode.SYSTEM, ThemeMode.fromStorageValue(""))
        assertEquals(ThemeMode.SYSTEM, ThemeMode.fromStorageValue("sepia"))
    }
}
