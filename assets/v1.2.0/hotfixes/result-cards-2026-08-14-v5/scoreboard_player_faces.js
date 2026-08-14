'use strict';

(function () {
    var base = Module.findBaseAddress('DreadHunger-Win64-Shipping.exe');
    if (base === null) {
        return;
    }

    var debugEnabled = false;
    var debugLogPath = '';
    try {
        var executableModule = Process.findModuleByName(
            'DreadHunger-Win64-Shipping.exe'
        );
        var executablePath = executableModule.path;
        var executableDirectory = executablePath.substring(
            0,
            executablePath.lastIndexOf('\\')
        );
        var debugMarker = new File(
            executableDirectory + '\\scoreboard_player_faces.debug',
            'r'
        );
        debugMarker.close();
        debugEnabled = true;
        debugLogPath = executableDirectory +
            '\\scoreboard_player_faces.debug.log';
    } catch (_) {}

    function debug(message) {
        if (!debugEnabled) {
            return;
        }
        try {
            var file = new File(debugLogPath, 'a');
            file.write('[' + new Date().toISOString() + '] ' + message + '\n');
            file.flush();
            file.close();
        } catch (_) {}
    }

    debug('v5 loaded; base=' + base);

    // Dread Hunger 1.2.4 / Hideout 1.2.
    var pregameAvatarInit = base.add(0xFCC3A0);
    var populateScoreboard = base.add(0xFC6550);
    var setScoreboardItemData = base.add(0xFE8950);
    var lobbyAvatarUpdate = base.add(0x1031060);
    var playerStateSetPlayerRole = base.add(0xEC6F20);
    var setBrushAddress = base.add(0x2457F10);
    var setTextAddress = base.add(0xFB3C20);
    var getRoleIconAddress = base.add(0xFC90C0);
    var reportCardRoleIconReturn = base.add(0xFF60B5);
    var reportCardRoleTextReturn = base.add(0xFF615E);

    var setBrushResourceObject = new NativeFunction(
        setBrushAddress,
        'void',
        ['pointer', 'pointer']
    );
    var getWeakObject = new NativeFunction(
        base.add(0x13E6CF0),
        'pointer',
        ['pointer']
    );
    var getPlainNameString = new NativeFunction(
        base.add(0x11D7830),
        'void',
        ['pointer', 'pointer']
    );
    var textFromString = new NativeFunction(
        base.add(0x110DD90),
        'pointer',
        ['pointer', 'pointer']
    );
    var setText = new NativeFunction(
        setTextAddress,
        'void',
        ['pointer', 'pointer']
    );
    var resolveScoreboardPlayer = new NativeFunction(
        base.add(0xEA91D0),
        'pointer',
        ['uint8', 'pointer']
    );

    var roleNames = {
        PR_Cannibal: 'Полугуль',
        PR_Explorer: 'Исследователь',
        PR_OldSailor: 'Старый моряк',
        PR_Witch: 'Ведьма'
    };
    var profileByPlayerName = Object.create(null);
    var profileByIcon = Object.create(null);
    var profileOrder = [];
    var pregameSlotByWidget = Object.create(null);
    var scoreboardProfiles = [];
    var captureByThread = Object.create(null);
    var resultCaptureByThread = Object.create(null);
    var reportCardCaptureByThread = Object.create(null);
    var retainedNativeMemory = [];
    var scoreboardIndex = 0;
    var reportCardIndex = 0;
    var lastPregameCaptureAt = 0;
    var lastScoreboardItemAt = 0;
    var lastReportCardAt = 0;

    function readFString(address) {
        try {
            var data = address.readPointer();
            var length = address.add(8).readS32();
            if (data.isNull() || length <= 0 || length > 256) {
                return '';
            }
            return data.readUtf16String(length);
        } catch (_) {
            return '';
        }
    }

    function makeOutputFString(capacity) {
        var value = Memory.alloc(16 + capacity * 2);
        value.writePointer(value.add(16));
        value.add(8).writeU32(0);
        value.add(12).writeU32(capacity);
        retainedNativeMemory.push(value);
        return value;
    }

    function getObjectName(object) {
        try {
            if (object.isNull()) {
                return '';
            }
            var value = makeOutputFString(128);
            getPlainNameString(object.add(0x18), value);
            return readFString(value);
        } catch (_) {
            return '';
        }
    }

    function roleLabelFromData(roleData) {
        var objectName = getObjectName(roleData);
        var keys = Object.keys(roleNames);
        for (var index = 0; index < keys.length; index++) {
            if (objectName.indexOf(keys[index]) !== -1) {
                return roleNames[keys[index]];
            }
        }
        return '';
    }

    function playerNameKey(playerName) {
        return playerName
            .replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
            .replace(/\u00A0/g, ' ')
            .trim()
            .toLowerCase();
    }

    function makeText(value) {
        var characters = Memory.alloc((value.length + 1) * 2);
        characters.writeUtf16String(value);
        var stringValue = Memory.alloc(16);
        stringValue.writePointer(characters);
        stringValue.add(8).writeS32(value.length + 1);
        stringValue.add(12).writeS32(value.length + 1);
        var textValue = Memory.alloc(24);
        textValue.writeByteArray([
            0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0
        ]);
        textFromString(textValue, stringValue);
        retainedNativeMemory.push(characters, stringValue, textValue);
        return textValue;
    }

    var textByRoleLabel = Object.create(null);
    Object.keys(roleNames).forEach(function (key) {
        var label = roleNames[key];
        try {
            textByRoleLabel[label] = makeText(label);
        } catch (error) {
            debug('makeText failed for ' + key + ': ' + error);
        }
    });

    function rememberProfile(playerName, icon, roleLabel) {
        var key = playerNameKey(playerName);
        if (key.length === 0) {
            return null;
        }

        var profile = profileByPlayerName[key];
        var incomingIconKey = '';
        if (icon !== null && icon !== undefined && !icon.isNull()) {
            incomingIconKey = icon.toString();
        }
        if (
            profile === undefined &&
            incomingIconKey.length !== 0 &&
            profileByIcon[incomingIconKey] !== undefined
        ) {
            profile = profileByIcon[incomingIconKey];
            profile.name = playerName;
            profileByPlayerName[key] = profile;
        }
        if (profile === undefined) {
            profile = {
                name: playerName,
                icon: null,
                roleLabel: ''
            };
            profileByPlayerName[key] = profile;
        }
        if (icon !== null && icon !== undefined && !icon.isNull()) {
            profile.icon = icon;
            profileByIcon[incomingIconKey] = profile;
        }
        if (roleLabel !== undefined && roleLabel.length !== 0) {
            profile.roleLabel = roleLabel;
        }
        return profile;
    }

    function rememberIconProfile(icon, roleLabel, playerName) {
        if (icon === null || icon === undefined || icon.isNull()) {
            return null;
        }

        var profile = null;
        if (playerName !== undefined && playerNameKey(playerName).length !== 0) {
            profile = rememberProfile(playerName, icon, roleLabel);
        }

        var key = icon.toString();
        if (profile === null) {
            profile = profileByIcon[key];
        }
        if (profile === undefined || profile === null) {
            profile = {
                name: '',
                icon: icon,
                roleLabel: ''
            };
        }
        profile.icon = icon;
        if (roleLabel !== undefined && roleLabel.length !== 0) {
            profile.roleLabel = roleLabel;
        }
        profileByIcon[key] = profile;
        return profile;
    }

    function rememberPregameProfile(widget, icon) {
        var now = Date.now();
        if (lastPregameCaptureAt === 0 || now - lastPregameCaptureAt > 5000) {
            profileOrder = [];
            pregameSlotByWidget = Object.create(null);
        }
        lastPregameCaptureAt = now;

        var profile = rememberIconProfile(icon, '', '');
        if (profile === null) {
            return;
        }

        // The pregame data starts with FText, not FString.  Key the card by
        // its stable widget instance instead of trying to decode the name.
        var widgetKey = widget.toString();
        var existingSlot = pregameSlotByWidget[widgetKey];
        if (existingSlot !== undefined) {
            profileOrder[existingSlot] = profile;
            return;
        }
        pregameSlotByWidget[widgetKey] = profileOrder.length;
        profileOrder.push(profile);
    }

    function resolveResultProfile(capture) {
        if (capture === null || capture === undefined) {
            return null;
        }
        if (capture.profile !== null && capture.profile !== undefined) {
            return capture.profile;
        }

        // ReplayPlayer.Name is also FText.  The scoreboard is built in the
        // same player order as the pregame avatar list, so use that stable
        // slot mapping and leave the native player-name widget untouched.
        var profile = capture.slot < profileOrder.length
            ? profileOrder[capture.slot]
            : null;

        capture.profile = profile;
        debug(
            'resolveResultProfile slot=' + capture.slot +
            ' order=' + profileOrder.length +
            ' profile=' + (profile === null ? 'null' :
                ('icon=' + profile.icon + ' role=' + profile.roleLabel))
        );
        if (capture.slot >= 0) {
            scoreboardProfiles[capture.slot] = profile;
        }
        return profile;
    }

    function setImage(view, icon) {
        if (view.isNull() || icon === null || icon === undefined || icon.isNull()) {
            return;
        }
        var playerImage = view.add(0x2C8).readPointer();
        if (!playerImage.isNull()) {
            setBrushResourceObject(playerImage, icon);
        }
    }

    function setRoleText(textBlock, roleLabel) {
        if (textBlock.isNull() || roleLabel.length === 0) {
            return;
        }
        var textValue = textByRoleLabel[roleLabel];
        if (textValue !== undefined) {
            setText(textBlock, textValue);
        }
    }

    function applyListItem(item, profile) {
        if (item.isNull() || profile === null || profile === undefined) {
            return;
        }
        if (profile.icon !== null) {
            item.add(0x290).writePointer(profile.icon);
            setImage(item.add(0x278).readPointer(), profile.icon);
        }
    }

    // Capture the exact face cards already rendered by the game before the
    // match.  This remains valid even though custom roles become PTR_UNKNOWN
    // in the saved match-stat records.
    Interceptor.attach(pregameAvatarInit, {
        onEnter: function (args) {
            try {
                var data = args[1];
                if (!data.isNull()) {
                    debug(
                        'pregameAvatarInit widget=' + args[0] +
                        ' icon=' + data.add(0x10).readPointer()
                    );
                    rememberPregameProfile(
                        args[0],
                        data.add(0x10).readPointer()
                    );
                }
            } catch (_) {}
        }
    });

    // Custom roles all use PTR_UNKNOWN in the native result record.  Capture
    // the real UDH_PlayerRoleData at the moment it is assigned to a player;
    // unlike the result enum, this object keeps PR_Cannibal/PR_Explorer/etc.
    Interceptor.attach(playerStateSetPlayerRole, {
        onEnter: function (args) {
            try {
                var playerState = args[0];
                var roleData = args[1];
                if (playerState.isNull() || roleData.isNull()) {
                    return;
                }
                rememberProfile(
                    readFString(playerState.add(0x300)),
                    null,
                    roleLabelFromData(roleData)
                );
                debug(
                    'playerStateSetPlayerRole state=' + playerState +
                    ' roleObject=' + getObjectName(roleData) +
                    ' label=' + roleLabelFromData(roleData)
                );
            } catch (_) {}
        }
    });

    // The lobby slot is the authoritative source for both the selected custom
    // role and its exact face portrait.  The role passed in args[1] is newer
    // than PlayerState.SelectedRole while a replicated slot is refreshing, so
    // use it first and keep SelectedRole only as a defensive fallback.
    Interceptor.attach(lobbyAvatarUpdate, {
        onEnter: function (args) {
            var threadId = Process.getCurrentThreadId();
            this.threadId = threadId;
            captureByThread[threadId] = null;
            try {
                var widget = args[0];
                var playerState = getWeakObject(widget.add(0x318));
                if (playerState.isNull()) {
                    return;
                }
                var selectedRole = args[1];
                if (selectedRole.isNull()) {
                    selectedRole = playerState.add(0x590).readPointer();
                }
                captureByThread[threadId] = {
                    playerName: readFString(playerState.add(0x300)),
                    roleLabel: roleLabelFromData(selectedRole),
                    targetImage: widget.add(0x2C0).readPointer(),
                    icon: null
                };
                debug(
                    'lobbyAvatarUpdate widget=' + widget +
                    ' state=' + playerState +
                    ' roleObject=' + getObjectName(selectedRole) +
                    ' label=' + roleLabelFromData(selectedRole)
                );
            } catch (_) {
                captureByThread[threadId] = null;
            }
        },
        onLeave: function () {
            var capture = captureByThread[this.threadId];
            delete captureByThread[this.threadId];
            if (capture !== null && capture !== undefined) {
                debug(
                    'lobbyAvatarUpdate leave icon=' + capture.icon +
                    ' label=' + capture.roleLabel
                );
                rememberIconProfile(
                    capture.icon,
                    capture.roleLabel,
                    capture.playerName
                );
            }
        }
    });

    Interceptor.attach(setBrushAddress, {
        onEnter: function (args) {
            try {
                var resultCapture = resultCaptureByThread[
                    Process.getCurrentThreadId()
                ];
                if (resultCapture !== null && resultCapture !== undefined) {
                    var itemView = resultCapture.item.add(0x278).readPointer();
                    var resultImage = itemView.isNull()
                        ? ptr(0)
                        : itemView.add(0x2C8).readPointer();
                    if (!resultImage.isNull() && args[0].equals(resultImage)) {
                        var resultProfile = resolveResultProfile(resultCapture);
                        if (
                            resultProfile !== null &&
                            resultProfile.icon !== null &&
                            !resultProfile.icon.isNull()
                        ) {
                            // Replace the fallback old-sailor icon in the same
                            // native call that would otherwise write it.
                            debug(
                                'replace list icon slot=' +
                                resultCapture.slot + ' old=' + args[1] +
                                ' new=' + resultProfile.icon
                            );
                            args[1] = resultProfile.icon;
                        }
                    }
                }

                var capture = captureByThread[Process.getCurrentThreadId()];
                if (
                    capture !== null &&
                    capture !== undefined &&
                    args[0].equals(capture.targetImage) &&
                    !args[1].isNull()
                ) {
                    capture.icon = args[1];
                }
            } catch (_) {}
        }
    });

    Interceptor.attach(setTextAddress, {
        onEnter: function (args) {
            try {
                if (!this.returnAddress.equals(reportCardRoleTextReturn)) {
                    return;
                }
                var threadId = Process.getCurrentThreadId();
                var profile = reportCardCaptureByThread[threadId];
                if (profile === null || profile === undefined ||
                    profile.roleLabel.length === 0) {
                    return;
                }
                var replacementText = textByRoleLabel[profile.roleLabel];
                if (replacementText !== undefined) {
                    // This call writes WBP_PlayerReportCard.RoleLabel.  Player
                    // name and red/blue team frame are separate widgets.
                    debug('replace report role text with ' + profile.roleLabel);
                    args[1] = replacementText;
                }
            } catch (_) {
            } finally {
                if (this.returnAddress.equals(reportCardRoleTextReturn)) {
                    delete reportCardCaptureByThread[
                        Process.getCurrentThreadId()
                    ];
                }
            }
        }
    });

    // WBP_PlayerReportCard is built in a native loop.  Its role-icon call is a
    // stable point where the current card can be paired with the pregame face
    // card.  Replacing the return value makes the native widget store the face
    // itself, so no later refresh can restore the old-sailor fallback icon.
    Interceptor.attach(getRoleIconAddress, {
        onEnter: function () {
            this.profile = null;
            this.isReportCard = false;
            try {
                if (!this.returnAddress.equals(reportCardRoleIconReturn)) {
                    return;
                }
                this.isReportCard = true;
                var now = Date.now();
                if (lastReportCardAt === 0 || now - lastReportCardAt > 1000) {
                    reportCardIndex = 0;
                }
                lastReportCardAt = now;
                this.profile = reportCardIndex < profileOrder.length
                    ? profileOrder[reportCardIndex]
                    : null;
                debug(
                    'report getRoleIcon index=' + reportCardIndex +
                    ' order=' + profileOrder.length +
                    ' profile=' + (this.profile === null ? 'null' :
                        ('icon=' + this.profile.icon +
                        ' role=' + this.profile.roleLabel))
                );
                reportCardIndex++;
                reportCardCaptureByThread[Process.getCurrentThreadId()] =
                    this.profile;
            } catch (_) {
                this.profile = null;
            }
        },
        onLeave: function (retval) {
            try {
                if (
                    this.isReportCard &&
                    this.profile !== null &&
                    this.profile.icon !== null &&
                    !this.profile.icon.isNull()
                ) {
                    debug(
                        'replace report icon old=' + retval +
                        ' new=' + this.profile.icon
                    );
                    retval.replace(this.profile.icon);
                }
            } catch (_) {}
        }
    });

    Interceptor.attach(populateScoreboard, {
        onEnter: function () {
            scoreboardIndex = 0;
            scoreboardProfiles = [];
            debug('populateScoreboard order=' + profileOrder.length);
        }
    });

    Interceptor.attach(setScoreboardItemData, {
        onEnter: function (args) {
            this.item = args[0];
            this.record = args[1];
            this.threadId = Process.getCurrentThreadId();
            this.scoreboardSlot = -1;
            this.profile = null;
            try {
                var record = this.record;
                if (this.item.isNull() || record.isNull()) {
                    return;
                }
                var now = Date.now();
                if (lastScoreboardItemAt === 0 || now - lastScoreboardItemAt > 1000) {
                    scoreboardIndex = 0;
                    scoreboardProfiles = [];
                }
                lastScoreboardItemAt = now;
                this.scoreboardSlot = scoreboardIndex;
                debug(
                    'setScoreboardItemData slot=' + this.scoreboardSlot +
                    ' order=' + profileOrder.length +
                    ' recordRole=' + record.add(0x2C).readU8() +
                    ' recordPlayer=' + record.add(0x2E).readU8()
                );
                scoreboardProfiles[scoreboardIndex] = null;
                scoreboardIndex++;
                resultCaptureByThread[this.threadId] = {
                    item: this.item,
                    record: this.record,
                    slot: this.scoreboardSlot,
                    profile: null
                };
            } catch (_) {
                this.record = ptr(0);
                this.scoreboardSlot = -1;
                resultCaptureByThread[this.threadId] = null;
            }
        },
        onLeave: function () {
            try {
                if (
                    this.scoreboardSlot < 0 ||
                    this.item.isNull() ||
                    this.record.isNull()
                ) {
                    return;
                }
                var capture = resultCaptureByThread[this.threadId];
                this.profile = resolveResultProfile(capture);
            } catch (_) {
                this.profile = null;
            }
            try {
                applyListItem(this.item, this.profile);
            } catch (_) {}
            delete resultCaptureByThread[this.threadId];
        }
    });

    debug('v5 hooks attached');
})();
