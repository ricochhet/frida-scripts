const DLL_NAME = "sqlcipher.dll";
const OUTPUT_FILE = "sqlite_dump.txt";

function findExport(moduleName, exportName) {
    if (moduleName) {
        try {
            const addr = Process.getModuleByName(moduleName).findExportByName(exportName);
            if (addr) return addr;
        } catch (_) {}
    }
    return Module.findGlobalExportByName(exportName);
}

function readBytesHex(ptr, len) {
    try {
        return Array.from(new Uint8Array(ptr.readByteArray(len)))
            .map(b => b.toString(16).padStart(2, "0"))
            .join(" ");
    } catch (_) {
        return "<unreadable>";
    }
}

function safeReadCString(ptr) {
    try {
        return ptr.isNull() ? "NULL" : ptr.readCString();
    } catch (_) {
        return "<invalid>";
    }
}

function logToFile(msg) {
    try {
        const f = new File(OUTPUT_FILE, "a");
        f.write(msg + "\n");
        f.flush();
        f.close();
    } catch (e) {
        console.error("[!] File write error:", e.message);
    }
}

function log(tag, msg) {
    const line = `[${tag}] ${msg}`;
    console.log(line);
    logToFile(line);
}

function hookKeyFunctions() {
    ["sqlite3_key", "sqlite3_key_v2"].forEach(function (name) {
        const fn = findExport(DLL_NAME, name);
        if (!fn) {
            console.warn(`[-] ${name} not found`);
            return;
        }

        Interceptor.attach(fn, {
            onEnter: function (args) {
                // sqlite3_key(db, key, keyLen)
                // sqlite3_key_v2(db, zDbName, key, keyLen)
                const isV2 = name === "sqlite3_key_v2";
                const keyPtr = isV2 ? args[2] : args[1];
                const keyLen = isV2 ? args[3].toInt32() : args[2].toInt32();

                if (keyLen <= 0 || keyLen > 1024) return;

                console.log(`\n[+] ${name} called  len=${keyLen}`);
                try {
                    console.log("[+] Key (string): " + keyPtr.readUtf8String(keyLen));
                } catch (_) {
                    console.log("[+] Key (hex): " + readBytesHex(keyPtr, keyLen));
                }
            }
        });

        console.log("[*] Hooked " + name);
    });
}

function hookExec() {
    const fn = findExport(DLL_NAME, "sqlite3_exec");
    if (!fn) { console.warn("[-] sqlite3_exec not found"); return; }

    Interceptor.attach(fn, {
        onEnter: function (args) {
            try {
                const sql = args[1].readUtf8String();
                if (!sql) return;
                log("SQL exec", sql);
                if (sql.toLowerCase().includes("pragma"))
                    console.log("[!!!] PRAGMA via exec detected");
            } catch (_) {}
        }
    });

    console.log("[*] Hooked sqlite3_exec");
}

function hookPrepare() {
    const fn = findExport(DLL_NAME, "sqlite3_prepare_v2");
    if (!fn) { console.warn("[-] sqlite3_prepare_v2 not found"); return; }

    Interceptor.attach(fn, {
        onEnter: function (args) {
            try {
                const sql = args[1].readUtf8String();
                if (!sql) return;
                log("SQL prepare", sql);
                if (sql.toLowerCase().includes("pragma"))
                    console.log("[!!!] PRAGMA via prepare detected");
            } catch (_) {}
        }
    });

    console.log("[*] Hooked sqlite3_prepare_v2");
}

function hookOpen() {
    const fn = findExport(DLL_NAME, "sqlite3_open_v2");
    if (!fn) { console.warn("[-] sqlite3_open_v2 not found"); return; }

    Interceptor.attach(fn, {
        onEnter: function (args) {
            try {
                const filename = args[0].readUtf8String();
                console.log("\n[+] Opening DB: " + filename);
                logToFile("[OPEN] " + filename);
            } catch (_) {}
        }
    });

    console.log("[*] Hooked sqlite3_open_v2");
}

function hookStep() {
    const stepAddr       = findExport(DLL_NAME, "sqlite3_step");
    const colCountAddr   = findExport(DLL_NAME, "sqlite3_column_count");
    const colTextAddr    = findExport(DLL_NAME, "sqlite3_column_text");

    if (!stepAddr || !colCountAddr || !colTextAddr) {
        console.warn("[-] sqlite3_step or column helpers not found");
        return;
    }

    const colCountFn = new NativeFunction(colCountAddr, "int",     ["pointer"]);
    const colTextFn  = new NativeFunction(colTextAddr,  "pointer", ["pointer", "int"]);

    const SQLITE_ROW = 100;

    Interceptor.attach(stepAddr, {
        onEnter: function (args) {
            this.stmt = args[0];
        },
        onLeave: function (retval) {
            if (!this.stmt || retval.toInt32() !== SQLITE_ROW) return;
            try {
                const count = colCountFn(this.stmt);
                const cols  = Array.from({ length: count }, (_, i) =>
                    safeReadCString(colTextFn(this.stmt, i))
                );
                log("ROW", cols.join(" | "));
            } catch (e) {
                console.error("[!] Error reading row:", e.message);
            }
        }
    });

    console.log("[*] Hooked sqlite3_step");
}

function installAllHooks() {
    console.log(`\n[*] ${DLL_NAME} loaded — installing hooks...\n`);
    hookKeyFunctions();
    hookExec();
    hookPrepare();
    hookStep();
    hookOpen();
}

Process.enumerateModules()
    .filter(m => /sql|cipher/i.test(m.name))
    .forEach(m => console.log("[*] Found module:", m.name));

const listener = Module.load.connect(function (mod) {
    if (mod.name.toLowerCase() === DLL_NAME.toLowerCase()) {
        listener.disconnect();
        installAllHooks();
    }
});

if (Process.findModuleByName(DLL_NAME)) {
    listener.disconnect();
    installAllHooks();
} else {
    console.log("\n[*] Waiting for module load...\n");
}