'use strict';

(function () {
    var base = Module.findBaseAddress('DreadHunger-Win64-Shipping.exe');
    if (base === null) {
        return;
    }

    // Dread Hunger 1.2.4 / Hideout 1.2.
    var pregameAvatarInit = base.add(0xFCC3A0);
    var populateScoreboard = base.add(0xFC6550);
    var setScoreboardItemData = base.add(0xFE8950);
    var lobbyAvatarUpdate = base.add(0x1031060);
    var reportCardSelectionChanged = base.add(0xFFE1D0);
    var playerStateSetPlayerRole = base.add(0xEC6F20);
    var setBrushAddress = base.add(0x2457F10);

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
        base.add(0xFB3C20),
        'void',
        ['pointer', 'pointer']
    );
    var getRoleIcon = new NativeFunction(
        base.add(0xFC90C0),
        'pointer',
        ['pointer']
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
    var scoreboardProfiles = [];
    var captureByThread = Object.create(null);
    var retainedNativeMemory = [];
    var scoreboardIndex = 0;

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
        textByRoleLabel[label] = makeText(label);
    });

    function rememberProfile(playerName, icon, roleLabel) {
        var key = playerNameKey(playerName);
        if (key.length === 0) {
            return null;
        }

        var profile = profileByPlayerName[key];
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
        }
        if (roleLabel !== undefined && roleLabel.length !== 0) {
            profile.roleLabel = roleLabel;
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
        if (profile.roleLabel.length !== 0) {
            var tooltip = item.add(0x2A0).readPointer();
            if (!tooltip.isNull()) {
                setRoleText(tooltip.add(0x260).readPointer(), profile.roleLabel);
            }
        }
    }

    function applyReportCard(widget, profile) {
        if (widget.isNull() || profile === null || profile === undefined) {
            return;
        }
        if (profile.roleLabel.length !== 0) {
            setRoleText(widget.add(0x298).readPointer(), profile.roleLabel);
        }
        if (profile.icon !== null) {
            var avatar = widget.add(0x278).readPointer();
            if (!avatar.isNull()) {
                setImage(avatar.add(0x260).readPointer(), profile.icon);
            }
        }
    }

    // Keep the original pregame capture as a fallback for unusual lobby flows.
    Interceptor.attach(pregameAvatarInit, {
        onEnter: function (args) {
            try {
                var data = args[1];
                if (!data.isNull()) {
                    rememberProfile(
                        readFString(data),
                        data.add(0x10).readPointer(),
                        ''
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
                var roleIcon = selectedRole.isNull()
                    ? null
                    : getRoleIcon(selectedRole);
                captureByThread[threadId] = {
                    playerName: readFString(playerState.add(0x300)),
                    roleLabel: roleLabelFromData(selectedRole),
                    targetImage: widget.add(0x2C0).readPointer(),
                    icon: roleIcon
                };
            } catch (_) {
                captureByThread[threadId] = null;
            }
        },
        onLeave: function () {
            var capture = captureByThread[this.threadId];
            delete captureByThread[this.threadId];
            if (capture !== null && capture !== undefined) {
                rememberProfile(
                    capture.playerName,
                    capture.icon,
                    capture.roleLabel
                );
            }
        }
    });

    Interceptor.attach(setBrushAddress, {
        onEnter: function (args) {
            try {
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

    Interceptor.attach(populateScoreboard, {
        onEnter: function () {
            scoreboardIndex = 0;
            scoreboardProfiles = [];
        }
    });

    Interceptor.attach(setScoreboardItemData, {
        onEnter: function (args) {
            this.item = args[0];
            this.record = args[1];
            this.scoreboardSlot = -1;
            this.profile = null;
            try {
                var record = this.record;
                if (this.item.isNull() || record.isNull()) {
                    return;
                }
                this.scoreboardSlot = scoreboardIndex;
                scoreboardProfiles[scoreboardIndex] = null;
                scoreboardIndex++;
            } catch (_) {
                this.record = ptr(0);
                this.scoreboardSlot = -1;
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
                // record+0x30 is the match-stat array, not the player name.
                // Resolve the same replay player object that the native widget
                // uses after it has bound the record, whose FString name lives
                // at +0x30.
                var replayPlayer = resolveScoreboardPlayer(
                    this.record.add(0x2E).readU8(),
                    this.item
                );
                var playerName = replayPlayer.isNull()
                    ? ''
                    : readFString(replayPlayer.add(0x30));
                var profile = profileByPlayerName[playerNameKey(playerName)];
                scoreboardProfiles[this.scoreboardSlot] = profile || null;
                if (profile !== undefined) {
                    this.profile = profile;
                }
            } catch (_) {
                this.profile = null;
            }
            try {
                applyListItem(this.item, this.profile);
            } catch (_) {}
        }
    });

    function firstSelectedIndex(selection) {
        try {
            if (selection.isNull() || selection.add(8).readS32() <= 0) {
                return -1;
            }
            var elements = selection.readPointer();
            if (elements.isNull()) {
                return -1;
            }
            return elements.readS32();
        } catch (_) {
            return -1;
        }
    }

    // The native report card cannot distinguish the four mod roles because all
    // of them use PTR_UNKNOWN.  Re-apply the captured profile after its native
    // refresh, leaving the native red/blue team frame untouched.
    Interceptor.attach(reportCardSelectionChanged, {
        onEnter: function (args) {
            this.widget = args[0];
            var index = firstSelectedIndex(args[1]);
            this.profile = index >= 0 ? scoreboardProfiles[index] : null;
        },
        onLeave: function () {
            try {
                applyReportCard(this.widget, this.profile);
            } catch (_) {}
        }
    });
})();
