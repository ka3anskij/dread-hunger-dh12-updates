(function () {
    'use strict';

    function startCleanRootUpdater() {
        try {
            var modules = Process.enumerateModules();
            if (modules.length === 0) {
                return;
            }

            var executablePath = modules[0].path;
            var lowerPath = executablePath.toLowerCase();
            var runtimeMarker = '\\.dh12_modpack\\runtime\\';
            if (lowerPath.indexOf(runtimeMarker) === -1) {
                return;
            }

            var win64Suffix = '\\dreadhunger\\binaries\\win64\\';
            var win64Index = lowerPath.lastIndexOf(win64Suffix);
            if (win64Index < 0) {
                return;
            }

            var runtimeRoot = executablePath.substring(0, win64Index);
            var win64Directory = executablePath.substring(
                0,
                win64Index + win64Suffix.length - 1
            );
            var helperPath = win64Directory
                + '\\Patches\\CleanRootUpdate\\HideoutCleanUpdate.exe';

            var getFileAttributesAddress = Module.findExportByName(
                'kernel32.dll',
                'GetFileAttributesW'
            );
            var shellExecuteAddress = Module.findExportByName(
                'shell32.dll',
                'ShellExecuteW'
            );
            if (getFileAttributesAddress === null || shellExecuteAddress === null) {
                return;
            }

            var getFileAttributes = new NativeFunction(
                getFileAttributesAddress,
                'uint32',
                ['pointer'],
                'win64'
            );
            var helperWide = Memory.allocUtf16String(helperPath);
            if (getFileAttributes(helperWide) === 0xffffffff) {
                return;
            }

            var shellExecute = new NativeFunction(
                shellExecuteAddress,
                'pointer',
                ['pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'int'],
                'win64'
            );
            var argumentsWide = Memory.allocUtf16String(
                '--runtime-root "' + runtimeRoot + '"'
            );
            shellExecute(
                ptr(0),
                ptr(0),
                helperWide,
                argumentsWide,
                ptr(0),
                0
            );
        } catch (_) {
            // The browser blocker itself must keep working even if the optional
            // clean-game updater is unavailable on this computer.
        }
    }

    startCleanRootUpdater();

    function readText(value, wide) {
        if (value.isNull()) {
            return '';
        }

        try {
            return wide ? value.readUtf16String() : value.readAnsiString();
        } catch (_) {
            return '';
        }
    }

    function isFreeTpLink(value) {
        return value.toLowerCase().indexOf('freetp') !== -1;
    }

    function blockCreateProcess(name, wide) {
        var address = Module.findExportByName('kernel32.dll', name);
        if (address === null) {
            return;
        }

        var argumentTypes = [
            'pointer', 'pointer', 'pointer', 'pointer', 'bool',
            'uint32', 'pointer', 'pointer', 'pointer', 'pointer'
        ];
        var original = new NativeFunction(address, 'bool', argumentTypes, 'win64');

        Interceptor.replace(address, new NativeCallback(function (
            applicationName,
            commandLine,
            processAttributes,
            threadAttributes,
            inheritHandles,
            creationFlags,
            environment,
            currentDirectory,
            startupInfo,
            processInformation
        ) {
            var application = readText(applicationName, wide);
            var command = readText(commandLine, wide);
            if (isFreeTpLink(application) || isFreeTpLink(command)) {
                return false;
            }

            return original(
                applicationName,
                commandLine,
                processAttributes,
                threadAttributes,
                inheritHandles,
                creationFlags,
                environment,
                currentDirectory,
                startupInfo,
                processInformation
            );
        }, 'bool', argumentTypes, 'win64'));
    }

    function blockWinExec() {
        var address = Module.findExportByName('kernel32.dll', 'WinExec');
        if (address === null) {
            return;
        }

        var original = new NativeFunction(
            address,
            'uint32',
            ['pointer', 'uint32'],
            'win64'
        );
        Interceptor.replace(address, new NativeCallback(function (commandLine, show) {
            if (isFreeTpLink(readText(commandLine, false))) {
                // WinExec treats values greater than 31 as success.
                return 33;
            }
            return original(commandLine, show);
        }, 'uint32', ['pointer', 'uint32'], 'win64'));
    }

    blockCreateProcess('CreateProcessA', false);
    blockCreateProcess('CreateProcessW', true);
    blockWinExec();

    function blockShellExecute(name, wide) {
        var address = Module.findExportByName('shell32.dll', name);
        if (address === null) {
            return;
        }

        var argumentTypes = [
            'pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'int'
        ];
        var original = new NativeFunction(
            address,
            'pointer',
            argumentTypes,
            'win64'
        );

        Interceptor.replace(address, new NativeCallback(function (
            windowHandle,
            operation,
            file,
            parameters,
            directory,
            showCommand
        ) {
            var target = readText(file, wide);
            var args = readText(parameters, wide);

            if (isFreeTpLink(target) || isFreeTpLink(args)) {
                // ShellExecute treats values greater than 32 as success.
                return ptr(33);
            }

            return original(
                windowHandle,
                operation,
                file,
                parameters,
                directory,
                showCommand
            );
        }, 'pointer', argumentTypes, 'win64'));
    }

    blockShellExecute('ShellExecuteA', false);
    blockShellExecute('ShellExecuteW', true);

    function blockShellExecuteEx(name, wide) {
        var address = Module.findExportByName('shell32.dll', name);
        if (address === null) {
            return;
        }

        var original = new NativeFunction(address, 'bool', ['pointer'], 'win64');

        Interceptor.replace(address, new NativeCallback(function (executeInfo) {
            if (executeInfo.isNull()) {
                return original(executeInfo);
            }

            // SHELLEXECUTEINFO on 64-bit Windows stores lpFile and lpParameters
            // at offsets 32 and 40 respectively.
            var target = readText(executeInfo.add(32).readPointer(), wide);
            var args = readText(executeInfo.add(40).readPointer(), wide);
            if (isFreeTpLink(target) || isFreeTpLink(args)) {
                return true;
            }

            return original(executeInfo);
        }, 'bool', ['pointer'], 'win64'));
    }

    blockShellExecuteEx('ShellExecuteExA', false);
    blockShellExecuteEx('ShellExecuteExW', true);
}());
