package com.globus.crm.feature.health.presentation.screen

import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.graphics.createBitmap
import com.globus.crm.feature.health.presentation.state.ConsentFormPdfUiEvent
import com.globus.crm.feature.health.presentation.state.ConsentFormPdfUiState
import java.io.File

@Composable
fun ConsentFormPdfScreen(
    state: ConsentFormPdfUiState,
    onEvent: (ConsentFormPdfUiEvent) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        when {
            state.isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            state.error != null -> Column(
                modifier = Modifier.align(Alignment.Center).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Icon(
                    Icons.Default.CloudOff,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(48.dp),
                )
                Text(state.error, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            state.pdfBytes != null -> ConsentPdfViewer(pdfBytes = state.pdfBytes)
        }
    }
}

@Composable
private fun ConsentPdfViewer(pdfBytes: ByteArray) {
    val context = LocalContext.current
    val bitmaps = remember(pdfBytes) {
        val file = File.createTempFile("consent_", ".pdf", context.cacheDir)
        file.writeBytes(pdfBytes)
        val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        val renderer = PdfRenderer(fd)
        val pages = mutableListOf<android.graphics.Bitmap>()
        for (i in 0 until renderer.pageCount) {
            val page = renderer.openPage(i)
            val bmp = createBitmap(page.width * 2, page.height * 2)
            bmp.eraseColor(android.graphics.Color.WHITE)
            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            page.close()
            pages.add(bmp)
        }
        renderer.close()
        fd.close()
        file.delete()
        pages
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .padding(bottom = 80.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            bitmaps.forEach { bmp ->
                Image(
                    bitmap = bmp.asImageBitmap(),
                    contentDescription = "Consent form page",
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.White),
                    contentScale = ContentScale.FillWidth,
                )
            }
        }

        FloatingActionButton(
            onClick = {
                val ok = savePdfToDownloads(context, pdfBytes, "consent_form_${System.currentTimeMillis()}.pdf")
                Toast.makeText(
                    context,
                    if (ok) "Saved to Downloads" else "Download failed",
                    Toast.LENGTH_SHORT,
                ).show()
            },
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(16.dp)
                .navigationBarsPadding(),
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        ) {
            Icon(Icons.Default.FileDownload, contentDescription = "Download PDF")
        }
    }
}

private fun savePdfToDownloads(context: android.content.Context, bytes: ByteArray, fileName: String): Boolean = try {
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
        val cv = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/pdf")
            put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
        }
        val uri = context.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv)
        if (uri != null) {
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            true
        } else false
    } else {
        @Suppress("DEPRECATION")
        val dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
        dir.mkdirs()
        java.io.File(dir, fileName).writeBytes(bytes)
        true
    }
} catch (e: Exception) { false }
