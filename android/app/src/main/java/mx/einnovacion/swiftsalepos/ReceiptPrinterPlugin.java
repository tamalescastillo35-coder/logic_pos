package mx.einnovacion.swiftsalepos;

import android.annotation.SuppressLint;
import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridges window.print() to Android's native print framework for the receipt ticket.
 *
 * Android's WebView does not show any print dialog on its own — JS window.print() only does
 * something if the *hosting app* implements WebChromeClient.onPrint() and wires it to
 * android.print.PrintManager (this is why the in-page "Imprimir Ticket" button silently did
 * nothing in the APK). Reusing the app's single shared Capacitor WebView for this would only
 * ever print whatever is currently visible on screen, not the ticket markup — so instead this
 * loads the ticket HTML into a short-lived, invisible WebView dedicated to the print job, then
 * hands that to PrintManager. The system dialog that opens from there lists every printer the
 * user has available (Bluetooth/WiFi print services) plus "Guardar como PDF".
 */
@CapacitorPlugin(name = "ReceiptPrinter")
public class ReceiptPrinterPlugin extends Plugin {

    @SuppressLint("SetJavaScriptEnabled")
    @PluginMethod
    public void print(PluginCall call) {
        String html = call.getString("html");
        String jobName = call.getString("jobName", "LOGIC POS - Ticket");
        if (html == null || html.isEmpty()) {
            call.reject("Falta el contenido del ticket a imprimir.");
            return;
        }

        getActivity().runOnUiThread(() -> {
            Context context = getContext();
            ViewGroup rootView = getActivity().findViewById(android.R.id.content);
            WebView printWebView = new WebView(context);
            // Zero-size but attached to the window: some Android versions render a blank page
            // when printing an unattached/unlaid-out WebView.
            printWebView.setLayoutParams(new ViewGroup.LayoutParams(1, 1));
            rootView.addView(printWebView);

            printWebView.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        PrintManager printManager = (PrintManager) context.getSystemService(Context.PRINT_SERVICE);
                        if (printManager == null) {
                            rootView.removeView(printWebView);
                            call.reject("El sistema no expone el servicio de impresión.");
                            return;
                        }
                        try {
                            printManager.print(jobName, view.createPrintDocumentAdapter(jobName), new PrintAttributes.Builder().build());
                            JSObject ret = new JSObject();
                            ret.put("value", true);
                            call.resolve(ret);
                        } catch (Exception ex) {
                            call.reject("No se pudo iniciar la impresión: " + ex.getMessage());
                        } finally {
                            rootView.removeView(printWebView);
                        }
                    }
                }
            );

            printWebView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }
}
