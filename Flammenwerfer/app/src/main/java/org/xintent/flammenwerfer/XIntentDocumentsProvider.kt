package org.xintent.flammenwerfer

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsProvider
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.runBlocking
import java.io.File
import java.io.FileOutputStream

abstract class BaseXIntentDocumentsProvider(
    private val rootId: String,
    private val rootTitle: String,
    private val rootSummary: String,
    private val defaultHoldOpenForWrite: Boolean,
) : DocumentsProvider() {

    companion object {
        private const val TAG = "BaseXIntentDocuments"
        private const val DOC_ID_ROOT = "root"

        private val DEFAULT_ROOT_PROJECTION = arrayOf(
            DocumentsContract.Root.COLUMN_ROOT_ID,
            DocumentsContract.Root.COLUMN_DOCUMENT_ID,
            DocumentsContract.Root.COLUMN_TITLE,
            DocumentsContract.Root.COLUMN_SUMMARY,
            DocumentsContract.Root.COLUMN_FLAGS,
            DocumentsContract.Root.COLUMN_MIME_TYPES,
            DocumentsContract.Root.COLUMN_ICON,
        )

        private val DEFAULT_DOCUMENT_PROJECTION = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_FLAGS,
        )
    }

    override fun onCreate(): Boolean {
        Log.i(TAG, "$rootTitle initialized (holdOpenForWrite=$defaultHoldOpenForWrite)")
        return true
    }

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val result = MatrixCursor(projection ?: DEFAULT_ROOT_PROJECTION)
        val row = result.newRow()
        row.add(DocumentsContract.Root.COLUMN_ROOT_ID, rootId)
        row.add(DocumentsContract.Root.COLUMN_DOCUMENT_ID, DOC_ID_ROOT)
        row.add(DocumentsContract.Root.COLUMN_TITLE, rootTitle)
        row.add(DocumentsContract.Root.COLUMN_SUMMARY, rootSummary)
        row.add(
            DocumentsContract.Root.COLUMN_FLAGS,
            DocumentsContract.Root.FLAG_SUPPORTS_CREATE or
                    DocumentsContract.Root.FLAG_SUPPORTS_RECENTS or
                    DocumentsContract.Root.FLAG_SUPPORTS_SEARCH,
        )
        row.add(DocumentsContract.Root.COLUMN_MIME_TYPES, "*/*")
        row.add(DocumentsContract.Root.COLUMN_ICON, R.mipmap.ic_launcher)
        return result
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val result = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)
        val row = result.newRow()

        if (documentId == DOC_ID_ROOT) {
            row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DOC_ID_ROOT)
            row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, rootTitle)
            row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.MIME_TYPE_DIR)
            row.add(DocumentsContract.Document.COLUMN_SIZE, 0L)
            row.add(
                DocumentsContract.Document.COLUMN_FLAGS,
                DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE or DocumentsContract.Document.FLAG_SUPPORTS_WRITE,
            )
        } else {
            val file = File(context?.cacheDir, documentId)
            row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, documentId)
            row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, file.name)
            row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, "*/*")
            row.add(DocumentsContract.Document.COLUMN_SIZE, if (file.exists()) file.length() else 0L)
            row.add(
                DocumentsContract.Document.COLUMN_FLAGS,
                DocumentsContract.Document.FLAG_SUPPORTS_WRITE or
                        DocumentsContract.Document.FLAG_SUPPORTS_DELETE,
            )
        }
        return result
    }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val result = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)

        val cacheDir = context?.cacheDir
        if (cacheDir != null && cacheDir.exists()) {
            cacheDir.listFiles()?.filter { it.name.startsWith("blob_") || it.name.startsWith("picked_") }?.forEach { file ->
                val row = result.newRow()
                row.add(DocumentsContract.Document.COLUMN_DOCUMENT_ID, file.name)
                row.add(DocumentsContract.Document.COLUMN_DISPLAY_NAME, file.name.removePrefix("blob_").removePrefix("picked_"))
                row.add(DocumentsContract.Document.COLUMN_MIME_TYPE, "*/*")
                row.add(DocumentsContract.Document.COLUMN_SIZE, file.length())
                row.add(
                    DocumentsContract.Document.COLUMN_FLAGS,
                    DocumentsContract.Document.FLAG_SUPPORTS_WRITE or DocumentsContract.Document.FLAG_SUPPORTS_DELETE,
                )
            }
        }
        return result
    }

    override fun createDocument(
        parentDocumentId: String,
        mimeType: String,
        displayName: String,
    ): String {
        val docId = "blob_${System.currentTimeMillis()}_$displayName"
        val file = File(context?.cacheDir, docId)
        file.createNewFile()
        return docId
    }

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?,
    ): ParcelFileDescriptor {
        val isWrite = mode.contains("w") || mode.contains("rwt")
        val ctx = context ?: throw IllegalStateException("Context is null")

        val file = File(ctx.cacheDir, documentId)
        if (!file.exists()) {
            file.createNewFile()
        }

        if (!isWrite && file.length() == 0L) {
            // Trigger fs.PickFile over HTTP bridge with defaultHoldOpenForWrite
            runBlocking {
                val res = XIntentClient.sendPickFileIntent(ctx, holdOpenForWrite = defaultHoldOpenForWrite)
                if (res.success && res.responseBody.isNotBlank()) {
                    val extracted = XIntentClient.extractReplacementText(res.responseBody)
                    if (!extracted.isNullOrBlank()) {
                        file.writeText(extracted)
                    }
                }
            }
        }

        val pfdMode = when {
            mode.contains("w") -> ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE
            else -> ParcelFileDescriptor.MODE_READ_ONLY
        }

        if (isWrite) {
            // Watch descriptor closing to broadcast XBlobBroadcast event
            val pipe = ParcelFileDescriptor.createPipe()
            val readSide = pipe[0]
            val writeSide = pipe[1]

            val blobId = "0x" + System.currentTimeMillis().toString(16)
            val fileName = file.name.removePrefix("blob_")

            Thread {
                try {
                    ParcelFileDescriptor.AutoCloseInputStream(readSide).use { inputStream ->
                        FileOutputStream(file).use { outputStream ->
                            inputStream.copyTo(outputStream)
                        }
                    }

                    val bytes = file.readBytes()
                    val base64Data = Base64.encodeToString(bytes, Base64.NO_WRAP)

                    runBlocking {
                        XIntentClient.sendXBlobBroadcast(
                            context = ctx,
                            blobId = blobId,
                            name = fileName,
                            type = "*/*",
                            size = bytes.size.toLong(),
                            dataType = "base64",
                            data = base64Data,
                        )
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error in XBlobBroadcast write watcher", e)
                }
            }.start()

            return writeSide
        }

        return ParcelFileDescriptor.open(file, pfdMode)
    }
}

class XIntentDocumentsProvider : BaseXIntentDocumentsProvider(
    rootId = "xintent_desktop_standard",
    rootTitle = "XIntent Desktop",
    rootSummary = "fs.PickFile (Standard / Read-Only)",
    defaultHoldOpenForWrite = false,
)

class XIntentHoldOpenDocumentsProvider : BaseXIntentDocumentsProvider(
    rootId = "xintent_desktop_hold_open",
    rootTitle = "XIntent Desktop (Hold Open)",
    rootSummary = "fs.PickFile (holdOpenForWrite = true)",
    defaultHoldOpenForWrite = true,
)
