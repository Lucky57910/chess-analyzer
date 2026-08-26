package io.github.lucky57910.chessanalyzer;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins are not discovered the way installed ones are, so
        // this registration is what makes `Stockfish` reachable from JS.
        registerPlugin(StockfishPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
