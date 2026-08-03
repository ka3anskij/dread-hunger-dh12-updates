(function () {
    'use strict';

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
        return value.toLowerCase().indexOf('freetp.org') !== -1;
    }

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
}());
