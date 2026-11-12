using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using Onda.Models;

namespace Onda.Services;

/// <summary>
/// Realtime room hub for lobby, presence, chat and WebRTC signaling.
/// Room metadata and chat history are persisted in SQLite while the room has
/// participants; an empty room is deleted from memory and disk immediately.
/// </summary>
public sealed class RoomService
{
    public const int MaxChatMessages = 120;
    public const int MaxRooms = 500;
    private const int PasswordHashIterations = 120_000;
    private const int PasswordSaltBytes = 16;
    private const int PasswordHashBytes = 32;
    private const int MaxSignalPayloadLength = 262_144;

    public static readonly TimeSpan StaleParticipantAfter = TimeSpan.FromMinutes(2);

    /// <summary>
    /// A room that becomes empty without an explicit close (a page reload,
    /// closed tab or lost circuit) is kept briefly so a refresh can rejoin it.
    /// The janitor deletes it, including all SQLite history, after this window.
    /// </summary>
    public static readonly TimeSpan EmptyRoomGrace = TimeSpan.FromSeconds(30);

    /// <summary>Short-lived, one-time token used to move a guest identity to the desktop app.</summary>
    public static readonly TimeSpan HandoffLifetime = TimeSpan.FromMinutes(5);

    private const string RoomCodeAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    private const int MaxHandoffTokens = 500;

    private readonly object _sync = new();
    private readonly Dictionary<string, RoomState> _rooms = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, HandoffState> _handoffs = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;
    private readonly ILogger<RoomService> _logger;
    private readonly MediaOptions _media;
    private readonly ChatStore _chatStore;

    public RoomService(
        TimeProvider time,
        ILogger<RoomService> logger,
        MediaOptions media,
        ChatStore chatStore)
    {
        _time = time;
        _logger = logger;
        _media = media;
        _chatStore = chatStore;
    }

    public int MaxParticipantsPerRoom => _media.EffectiveMaxParticipants;

    /// <summary>Raised whenever participants, media state or participant names change.</summary>
    public event Action<string>? RoomChanged;

    /// <summary>Raised when a room's chat log receives a new message.</summary>
    public event Action<string>? ChatChanged;

    /// <summary>Raised when the public lobby summary changes (join, leave, room created/removed).</summary>
    public event Action? LobbyChanged;

    /// <summary>Raised with a routed WebRTC signaling payload.</summary>
    public event Action<RelaySignal>? SignalReceived;

    public CreateRoomResult CreateRoom(string? rawName, string? password, string ownerId, string? ownerName)
    {
        if (string.IsNullOrWhiteSpace(ownerId))
        {
            return new CreateRoomResult(false, null, "Sessão inválida. Recarregue a página.");
        }

        if (!InputRules.TryNormalizeDisplayName(ownerName, out var normalizedOwnerName, out var ownerError))
        {
            return new CreateRoomResult(false, null, ownerError);
        }

        if (!InputRules.TryNormalizeRoomName(rawName, out var roomName, out var nameError))
        {
            return new CreateRoomResult(false, null, nameError);
        }

        string? passwordSalt = null;
        string? passwordHash = null;
        if (!string.IsNullOrWhiteSpace(password))
        {
            if (!InputRules.TryNormalizePassword(password, out var normalizedPassword, out var passwordError))
            {
                return new CreateRoomResult(false, null, passwordError);
            }

            passwordSalt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(PasswordSaltBytes));
            passwordHash = HashPassword(normalizedPassword, passwordSalt);
        }

        var now = _time.GetUtcNow();
        RoomState room;
        lock (_sync)
        {
            if (_rooms.Count >= MaxRooms)
            {
                PurgeEmptyRoomsLocked(now);
                if (_rooms.Count >= MaxRooms)
                {
                    return new CreateRoomResult(false, null, "Muitas salas ativas. Tente novamente em instantes.");
                }
            }

            var code = GenerateUniqueRoomCodeLocked();
            room = new RoomState
            {
                Id = code,
                Name = roomName,
                OwnerId = ownerId,
                OwnerName = normalizedOwnerName,
                CreatedAt = now,
                LastActivityAt = now,
                EmptySince = now,
                PasswordSalt = passwordSalt,
                PasswordHash = passwordHash
            };

            try
            {
                _chatStore.InsertRoom(
                    room.Id,
                    room.Name,
                    room.OwnerId,
                    room.OwnerName,
                    room.CreatedAt,
                    room.PasswordSalt,
                    room.PasswordHash);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not persist room {RoomCode}.", room.Id);
                return new CreateRoomResult(false, null, "Não foi possível criar a sala agora. Tente novamente.");
            }

            _rooms.Add(code, room);
        }

        _logger.LogInformation("Room {RoomCode} created by {OwnerName}.", room.Id, normalizedOwnerName);
        RaiseLobbyChanged();

        return new CreateRoomResult(true, room.Id, null);
    }

    /// <summary>Returns null when the room does not exist.</summary>
    public RoomInfoView? GetRoomInfo(string? rawCode, string guestId)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return null;
        }

        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room))
            {
                return null;
            }

            var isParticipant = room.Participants.ContainsKey(guestId);
            var isOwner = string.Equals(room.OwnerId, guestId, StringComparison.Ordinal);
            return new RoomInfoView(
                room.Id,
                room.Name,
                room.HasPassword,
                RequiresPassword: room.HasPassword && !isOwner && !isParticipant,
                IsFull: !isParticipant && room.Participants.Count >= MaxParticipantsPerRoom,                IsOwner: isOwner,
                ParticipantCount: room.Participants.Count,
                MaxParticipants: MaxParticipantsPerRoom,
                OwnerName: room.OwnerName);
        }
    }

    /// <summary>
    /// Creates a short-lived, one-time token that lets the desktop app continue
    /// as the current guest (including room ownership).
    /// </summary>
    public CreateHandoffResult CreateHandoffToken(string? rawCode, string guestId)
    {
        if (string.IsNullOrWhiteSpace(guestId))
        {
            return new CreateHandoffResult(false, null, "Sessão inválida.");
        }

        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return new CreateHandoffResult(false, null, "Sala inválida.");
        }

        var now = _time.GetUtcNow();
        lock (_sync)
        {
            PruneHandoffsLocked(now);

            if (!_rooms.TryGetValue(code, out var room))
            {
                return new CreateHandoffResult(false, null, "Essa sala não existe mais.");
            }

            if (!room.Participants.TryGetValue(guestId, out var participant))
            {
                return new CreateHandoffResult(false, null, "Você não está mais na sala.");
            }

            if (_handoffs.Count >= MaxHandoffTokens)
            {
                return new CreateHandoffResult(false, null, "Muitas transferências em andamento. Tente novamente.");
            }

            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            _handoffs[token] = new HandoffState
            {
                RoomId = room.Id,
                GuestId = guestId,
                Name = participant.Name,
                AvatarTone = participant.AvatarTone,
                ExpiresAt = now + HandoffLifetime
            };

            return new CreateHandoffResult(true, token, null);
        }
    }

    /// <summary>
    /// Consumes a handoff token and transfers the previous guest identity,
    /// ownership and room access to the desktop session.
    /// </summary>
    public RedeemHandoffResult RedeemHandoffToken(string? rawCode, string? token, string newGuestId)
    {
        if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(newGuestId))
        {
            return new RedeemHandoffResult(false, null, 0, "Token de transferência inválido.");
        }

        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return new RedeemHandoffResult(false, null, 0, "Sala inválida.");
        }

        var now = _time.GetUtcNow();
        var changed = false;
        RedeemHandoffResult result;

        lock (_sync)
        {
            PruneHandoffsLocked(now);

            if (!_handoffs.TryGetValue(token, out var handoff))
            {
                return new RedeemHandoffResult(false, null, 0, "Este link de transferência expirou ou já foi usado.");
            }

            if (handoff.ExpiresAt <= now)
            {
                _handoffs.Remove(token);
                return new RedeemHandoffResult(false, null, 0, "Este link de transferência expirou.");
            }

            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.Id, handoff.RoomId, StringComparison.OrdinalIgnoreCase))
            {
                _handoffs.Remove(token);
                return new RedeemHandoffResult(false, null, 0, "A sala da transferência não existe mais.");
            }

            if (!room.Participants.TryGetValue(handoff.GuestId, out var previous) ||
                string.Equals(handoff.GuestId, newGuestId, StringComparison.Ordinal))
            {
                _handoffs.Remove(token);
                return new RedeemHandoffResult(false, null, 0, "A sessão anterior não está mais disponível.");
            }

            _handoffs.Remove(token);
            room.Participants.Remove(handoff.GuestId);
            room.RevokedGuestIds.Add(handoff.GuestId);
            room.HandoffBypassGuestIds.Add(newGuestId);

            if (string.Equals(room.OwnerId, handoff.GuestId, StringComparison.Ordinal))
            {
                room.OwnerId = newGuestId;
                room.OwnerName = previous.Name;
                PersistOwnerNameLocked(room, previous.Name, now);
            }

            if (room.Participants.Count == 0)
            {
                room.EmptySince = now;
            }

            room.LastActivityAt = now;
            changed = true;
            result = new RedeemHandoffResult(true, previous.Name, previous.AvatarTone, null);
        }

        if (changed)
        {
            _logger.LogInformation("Room {RoomCode} handoff redeemed by a new desktop session.", code);
            RaiseRoomChanged(code);
            RaiseLobbyChanged();
        }

        return result;
    }

    private void PruneHandoffsLocked(DateTimeOffset now)
    {
        foreach (var expired in _handoffs
            .Where(pair => pair.Value.ExpiresAt <= now)
            .Select(pair => pair.Key)
            .ToArray())
        {
            _handoffs.Remove(expired);
        }
    }

    public RoomView? GetSnapshot(string? rawCode)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return null;
        }

        lock (_sync)
        {
            return _rooms.TryGetValue(code, out var room) ? ToViewLocked(room) : null;
        }
    }

    /// <summary>Only rooms with people inside are shown in the lobby.</summary>
    public IReadOnlyList<RoomSummaryView> GetActiveRooms()
    {
        lock (_sync)
        {
            return _rooms.Values
                .Where(r => r.Participants.Count > 0)
                .OrderByDescending(r => r.Participants.Count)
                .ThenByDescending(r => r.LastActivityAt)
                .Select(ToSummaryLocked)
                .ToArray();
        }
    }

    public JoinRoomResult JoinRoom(string? rawCode, string guestId, int avatarTone, string? guestName, string? password)
    {
        if (string.IsNullOrWhiteSpace(guestId))
        {
            return new JoinRoomResult(JoinRoomStatus.InvalidInput, "Sessão inválida.", null);
        }

        if (!InputRules.TryNormalizeDisplayName(guestName, out var normalizedName, out var nameError))
        {
            return new JoinRoomResult(JoinRoomStatus.InvalidInput, nameError, null);
        }

        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return new JoinRoomResult(JoinRoomStatus.NotFound, "Sala não encontrada.", null);
        }

        RoomView? snapshot = null;
        var status = JoinRoomStatus.Success;
        string? error = null;
        var becameActive = false;
        var changed = false;
        var chatChanged = false;
        var now = _time.GetUtcNow();

        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room))
            {
                return new JoinRoomResult(JoinRoomStatus.NotFound, "Essa sala não existe mais.", null);
            }

            if (room.RevokedGuestIds.Contains(guestId))
            {
                return new JoinRoomResult(
                    JoinRoomStatus.InvalidInput,
                    "Esta sessão foi transferida para outro dispositivo. Entre novamente.",
                    null);
            }

            var handoffBypass = room.HandoffBypassGuestIds.Remove(guestId);
            if (room.Participants.TryGetValue(guestId, out var existing))
            {
                // Rejoining the same room within the same circuit: refresh presence.
                var nameChanged = !string.Equals(existing.Name, normalizedName, StringComparison.Ordinal);
                existing.Name = normalizedName;
                existing.LastSeen = now;
                if (string.Equals(room.OwnerId, guestId, StringComparison.Ordinal))
                {
                    room.OwnerName = normalizedName;
                    if (nameChanged)
                    {
                        PersistOwnerNameLocked(room, normalizedName, now);
                    }
                }

                room.LastActivityAt = now;
                room.EmptySince = null;
                changed = nameChanged;
                snapshot = ToViewLocked(room, includeMessages: true);
            }
            else if (room.HasPassword && !string.Equals(room.OwnerId, guestId, StringComparison.Ordinal) && !handoffBypass)
            {
                if (string.IsNullOrWhiteSpace(password) || !VerifyPassword(password, room))
                {
                    status = JoinRoomStatus.WrongPassword;
                    error = "Senha incorreta. Tente novamente.";
                }
            }

            if (status == JoinRoomStatus.Success && snapshot is null)
            {
                if (room.Participants.Count >= MaxParticipantsPerRoom)
                {
                    status = JoinRoomStatus.Full;
                    error = "Esta sala já está cheia.";
                }
                else
                {
                    var isOwner = string.Equals(room.OwnerId, guestId, StringComparison.Ordinal);
                    if (isOwner)
                    {
                        room.OwnerName = normalizedName;
                        PersistOwnerNameLocked(room, normalizedName, now);
                    }

                    room.Participants[guestId] = new ParticipantState
                    {
                        Id = guestId,
                        Name = normalizedName,
                        AvatarTone = Math.Clamp(avatarTone, 0, GuestSession.AvatarToneCount - 1),
                        JoinedAt = now,
                        LastSeen = now
                    };

                    room.EmptySince = null;
                    chatChanged = AddSystemMessageLocked(room, $"{normalizedName} entrou na sala.");
                    becameActive = room.Participants.Count == 1;
                    room.LastActivityAt = now;
                    snapshot = ToViewLocked(room, includeMessages: true);
                    changed = true;
                }
            }
        }

        if (status != JoinRoomStatus.Success || snapshot is null)
        {
            return new JoinRoomResult(status, error, null);
        }

        if (chatChanged)
        {
            RaiseChatChanged(code);
        }

        if (changed || becameActive)
        {
            RaiseRoomChanged(code);
        }

        if (becameActive)
        {
            RaiseLobbyChanged();
        }

        return new JoinRoomResult(JoinRoomStatus.Success, null, snapshot);
    }

    public void LeaveRoom(string? rawCode, string guestId, bool closeIfEmpty = false)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return;
        }

        var changed = false;
        var chatChanged = false;
        var roomRemoved = false;
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room))
            {
                return;
            }

            if (room.Participants.Remove(guestId, out var participant))
            {
                if (room.Participants.Count == 0)
                {
                    if (closeIfEmpty)
                    {
                        // Explicit "Sair": destroy the room immediately.
                        _rooms.Remove(code);
                        DeletePersistedRoomLocked(room.Id);
                        roomRemoved = true;
                    }
                    else
                    {
                        // Reloads, closed tabs and lost circuits get a short
                        // grace window so a refresh can rejoin the same room.
                        room.EmptySince = now;
                        room.LastActivityAt = now;
                        chatChanged = AddSystemMessageLocked(room, $"{participant.Name} saiu da sala.");
                        changed = true;
                    }
                }
                else
                {
                    room.EmptySince = null;
                    room.LastActivityAt = now;
                    chatChanged = AddSystemMessageLocked(room, $"{participant.Name} saiu da sala.");
                    changed = true;
                }
            }
            else if (closeIfEmpty && room.Participants.Count == 0)
            {
                // The pagehide beacon may have removed the participant just
                // before the explicit Sair request arrived.
                _rooms.Remove(code);
                DeletePersistedRoomLocked(room.Id);
                roomRemoved = true;
            }
        }

        if (changed)
        {
            RaiseRoomChanged(code);
        }

        if (chatChanged)
        {
            RaiseChatChanged(code);
        }

        if (roomRemoved || changed)
        {
            RaiseLobbyChanged();
        }
    }

    public bool RenameParticipant(string? rawCode, string guestId, string? rawName, out string? error)
    {
        error = null;
        if (!InputRules.TryNormalizeDisplayName(rawName, out var normalizedName, out error))
        {
            return false;
        }

        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var changed = false;
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !room.Participants.TryGetValue(guestId, out var participant))
            {
                error = "Você não está mais nesta sala.";
                return false;
            }

            if (string.Equals(participant.Name, normalizedName, StringComparison.Ordinal))
            {
                return true;
            }

            participant.Name = normalizedName;
            participant.LastSeen = now;
            if (string.Equals(room.OwnerId, guestId, StringComparison.Ordinal))
            {
                room.OwnerName = normalizedName;
                PersistOwnerNameLocked(room, normalizedName, now);
            }

            room.LastActivityAt = now;
            changed = true;
        }

        if (changed)
        {
            RaiseRoomChanged(code);
            RaiseLobbyChanged();
        }

        return true;
    }

    public void UpdateMediaState(
        string? rawCode,
        string guestId,
        bool micOn,
        bool cameraOn,
        bool screenOn,
        bool screenWithAudio)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return;
        }

        var changed = false;
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !room.Participants.TryGetValue(guestId, out var participant))
            {
                return;
            }

            // A user shares one video source at a time (camera or screen).
            if (cameraOn && screenOn)
            {
                cameraOn = false;
            }

            changed =
                participant.MicOn != micOn ||
                participant.CameraOn != cameraOn ||
                participant.ScreenOn != screenOn ||
                participant.ScreenWithAudio != screenWithAudio;

            participant.MicOn = micOn;
            participant.CameraOn = cameraOn;
            participant.ScreenOn = screenOn;
            participant.ScreenWithAudio = screenOn && screenWithAudio;
            if (!micOn)
            {
                participant.Speaking = false;
            }

            participant.LastSeen = _time.GetUtcNow();
            if (changed)
            {
                room.LastActivityAt = participant.LastSeen;
            }
        }

        if (changed)
        {
            RaiseRoomChanged(code);
        }
    }

    public void UpdateSpeaking(string? rawCode, string guestId, bool speaking)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return;
        }

        var changed = false;
        lock (_sync)
        {
            if (_rooms.TryGetValue(code, out var room) &&
                room.Participants.TryGetValue(guestId, out var participant) &&
                participant.Speaking != speaking)
            {
                participant.Speaking = speaking && participant.MicOn;
                changed = true;
                room.LastActivityAt = _time.GetUtcNow();
            }
        }

        if (changed)
        {
            RaiseRoomChanged(code);
        }
    }

    public bool SendChatMessage(string? rawCode, string guestId, string? rawText, out string? error)
    {
        error = null;
        if (!InputRules.TryNormalizeChat(rawText, out var text, out error))
        {
            return false;
        }

        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !room.Participants.TryGetValue(guestId, out var participant))
            {
                error = "Você não está mais nesta sala.";
                return false;
            }

            // A tiny cooldown makes accidental double-enter harmless without getting in the way.
            if (now - participant.LastMessageAt < TimeSpan.FromMilliseconds(180))
            {
                return true;
            }

            try
            {
                _chatStore.AppendMessage(
                    room.Id,
                    participant.Id,
                    participant.Name,
                    text,
                    now,
                    isSystem: false,
                    MaxChatMessages);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not persist a chat message for room {RoomCode}.", room.Id);
                error = "Não foi possível salvar a mensagem. Tente novamente.";
                return false;
            }

            participant.LastMessageAt = now;
            participant.LastSeen = now;
            room.LastActivityAt = now;
        }

        RaiseChatChanged(code);
        return true;
    }

    public void RelaySignal(string? rawCode, string fromId, string toId, string payload)
    {
        if (string.IsNullOrWhiteSpace(fromId) ||
            string.IsNullOrWhiteSpace(toId) ||
            string.Equals(fromId, toId, StringComparison.Ordinal) ||
            payload.Length > MaxSignalPayloadLength)
        {
            return;
        }

        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return;
        }

        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !room.Participants.ContainsKey(fromId) ||
                !room.Participants.ContainsKey(toId))
            {
                return;
            }
        }

        RaiseSignal(new RelaySignal(code, fromId, toId, payload));
    }

    /// <summary>Heartbeat from an open room page. Does not resurrect removed participants.</summary>
    public void Touch(string? rawCode, string guestId)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return;
        }

        lock (_sync)
        {
            if (_rooms.TryGetValue(code, out var room) &&
                room.Participants.TryGetValue(guestId, out var participant))
            {
                participant.LastSeen = _time.GetUtcNow();
            }
        }
    }

    /// <summary>Removes ghost participants and closes rooms that became empty.</summary>
    public void PurgeStale()
    {
        var now = _time.GetUtcNow();
        var changedRooms = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var chatChangedRooms = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var lobbyChanged = false;

        lock (_sync)
        {
            foreach (var room in _rooms.Values.ToArray())
            {
                var stale = room.Participants.Values
                    .Where(p => now - p.LastSeen > StaleParticipantAfter)
                    .ToArray();

                if (stale.Length == 0)
                {
                    continue;
                }

                foreach (var participant in stale)
                {
                    room.Participants.Remove(participant.Id);
                }

                if (room.Participants.Count == 0)
                {
                    // The last real user disappeared without a clean leave.
                    // Keep the room briefly for a reload, then PurgeEmptyRooms
                    // deletes it together with the complete chat history.
                    room.EmptySince ??= now;
                    room.LastActivityAt = now;
                    foreach (var participant in stale)
                    {
                        if (AddSystemMessageLocked(room, $"{participant.Name} saiu por inatividade."))
                        {
                            chatChangedRooms.Add(room.Id);
                        }
                    }

                    lobbyChanged = true;
                    continue;
                }

                room.LastActivityAt = now;
                changedRooms.Add(room.Id);
                foreach (var participant in stale)
                {
                    if (AddSystemMessageLocked(room, $"{participant.Name} saiu por inatividade."))
                    {
                        chatChangedRooms.Add(room.Id);
                    }
                }

                lobbyChanged = true;
            }

            if (PurgeEmptyRoomsLocked(now) > 0)
            {
                lobbyChanged = true;
            }
        }

        foreach (var roomId in changedRooms)
        {
            RaiseRoomChanged(roomId);
        }

        foreach (var roomId in chatChangedRooms)
        {
            RaiseChatChanged(roomId);
        }

        if (lobbyChanged)
        {
            RaiseLobbyChanged();
        }
    }

    /// <summary>
    /// Deletes rooms that have been empty past the reload grace window. A room
    /// is only persisted while it has users, so this removes its complete chat
    /// history as well.
    /// </summary>
    private int PurgeEmptyRoomsLocked(DateTimeOffset now)
    {
        var empty = _rooms.Values
            .Where(r => r.Participants.Count == 0 &&
                        now - (r.EmptySince ?? r.CreatedAt) >= EmptyRoomGrace)
            .Select(r => r.Id)
            .ToArray();

        foreach (var id in empty)
        {
            _rooms.Remove(id);
            DeletePersistedRoomLocked(id);
        }

        return empty.Length;
    }

    private void RaiseRoomChanged(string roomId)
    {
        var handlers = RoomChanged;
        if (handlers is null)
        {
            return;
        }

        foreach (var callback in handlers.GetInvocationList())
        {
            try
            {
                ((Action<string>)callback)(roomId);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "A room subscriber failed for {RoomCode}.", roomId);
            }
        }
    }

    private void RaiseChatChanged(string roomId)
    {
        var handlers = ChatChanged;
        if (handlers is null)
        {
            return;
        }

        foreach (var callback in handlers.GetInvocationList())
        {
            try
            {
                ((Action<string>)callback)(roomId);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "A chat subscriber failed for {RoomCode}.", roomId);
            }
        }
    }

    private void RaiseLobbyChanged()
    {
        var handlers = LobbyChanged;
        if (handlers is null)
        {
            return;
        }

        foreach (var callback in handlers.GetInvocationList())
        {
            try
            {
                ((Action)callback)();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "A lobby subscriber failed.");
            }
        }
    }

    private void RaiseSignal(RelaySignal signal)
    {
        var handlers = SignalReceived;
        if (handlers is null)
        {
            return;
        }

        foreach (var callback in handlers.GetInvocationList())
        {
            try
            {
                ((Action<RelaySignal>)callback)(signal);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "A signal subscriber failed for {RoomCode}.", signal.RoomId);
            }
        }
    }

    private RoomView ToViewLocked(RoomState room, bool includeMessages = false)
    {
        var participants = room.Participants.Values
            .OrderBy(p => p.JoinedAt)
            .ThenBy(p => p.Id, StringComparer.Ordinal)
            .Select(p => new ParticipantView(
                p.Id,
                p.Name,
                p.AvatarTone,
                string.Equals(p.Id, room.OwnerId, StringComparison.Ordinal),
                p.MicOn,
                p.CameraOn,
                p.ScreenOn,
                p.ScreenWithAudio,
                p.Speaking,
                p.JoinedAt))
            .ToArray();

        IReadOnlyList<ChatMessageView> messages = includeMessages
            ? LoadMessages(room.Id)
            : [];

        return new RoomView(
            room.Id,
            room.Name,
            room.HasPassword,
            MaxParticipantsPerRoom,
            room.CreatedAt,
            room.OwnerName,
            participants,
            messages);
    }

    /// <summary>
    /// Returns the persisted chat log for a live room. Used by the chat panel
    /// when a ChatChanged event arrives, keeping snapshots cheap for media and
    /// speaking updates.
    /// </summary>
    public IReadOnlyList<ChatMessageView> GetChatMessages(string? rawCode)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return [];
        }

        lock (_sync)
        {
            if (!_rooms.ContainsKey(code))
            {
                return [];
            }
        }

        return LoadMessages(code);
    }

    private IReadOnlyList<ChatMessageView> LoadMessages(string roomId)
    {
        try
        {
            return _chatStore.GetRecentMessages(roomId, MaxChatMessages);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not read chat messages for room {RoomCode}.", roomId);
            return [];
        }
    }

    private RoomSummaryView ToSummaryLocked(RoomState room)
    {
        var people = room.Participants.Values
            .OrderBy(p => p.JoinedAt)
            .Take(4)
            .Select(p => new RoomPersonView(p.Name, p.AvatarTone, p.Speaking))
            .ToArray();

        return new RoomSummaryView(
            room.Id,
            room.Name,
            room.HasPassword,
            room.Participants.Count,
            MaxParticipantsPerRoom,
            room.CreatedAt,
            room.OwnerName,
            people);
    }

    private bool AddSystemMessageLocked(RoomState room, string text)
    {
        try
        {
            _chatStore.AppendMessage(
                room.Id,
                senderId: null,
                senderName: string.Empty,
                text,
                _time.GetUtcNow(),
                isSystem: true,
                MaxChatMessages);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not persist a system message for room {RoomCode}.", room.Id);
            return false;
        }
    }

    private void PersistOwnerNameLocked(RoomState room, string ownerName, DateTimeOffset now)
    {
        try
        {
            _chatStore.UpdateOwnerName(room.Id, ownerName, now);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not persist the owner name for room {RoomCode}.", room.Id);
        }
    }

    private void DeletePersistedRoomLocked(string roomId)
    {
        try
        {
            _chatStore.DeleteRoom(roomId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not delete the persisted history for room {RoomCode}.", roomId);
        }
    }

    private string GenerateUniqueRoomCodeLocked()
    {
        for (var attempt = 0; attempt < 64; attempt++)
        {
            var chars = new char[6];
            for (var i = 0; i < chars.Length; i++)
            {
                chars[i] = RoomCodeAlphabet[RandomNumberGenerator.GetInt32(RoomCodeAlphabet.Length)];
            }

            var candidate = new string(chars);
            if (!_rooms.ContainsKey(candidate))
            {
                return candidate;
            }
        }

        // Extremely unlikely fallback.
        return Guid.NewGuid().ToString("N")[..10];
    }

    private static string HashPassword(string password, string salt)
    {
        var hash = Rfc2898DeriveBytes.Pbkdf2(
            password,
            Convert.FromBase64String(salt),
            PasswordHashIterations,
            HashAlgorithmName.SHA256,
            PasswordHashBytes);
        return Convert.ToBase64String(hash);
    }

    private static bool VerifyPassword(string password, RoomState room)
    {
        if (room.PasswordSalt is null || room.PasswordHash is null)
        {
            return true;
        }

        var computed = HashPassword(password.Trim(), room.PasswordSalt);
        var expected = room.PasswordHash;
        if (computed.Length != expected.Length)
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.ASCII.GetBytes(computed),
            System.Text.Encoding.ASCII.GetBytes(expected));
    }

    private sealed class HandoffState
    {
        public required string RoomId { get; init; }
        public required string GuestId { get; init; }
        public required string Name { get; init; }
        public int AvatarTone { get; init; }
        public DateTimeOffset ExpiresAt { get; init; }
    }

    private sealed class RoomState
    {
        public required string Id { get; init; }
        public required string Name { get; init; }
        public required string OwnerId { get; set; }
        public required string OwnerName { get; set; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset LastActivityAt { get; set; }
        public DateTimeOffset? EmptySince { get; set; }
        public string? PasswordSalt { get; init; }
        public string? PasswordHash { get; init; }
        public bool HasPassword => !string.IsNullOrEmpty(PasswordHash);
        public Dictionary<string, ParticipantState> Participants { get; } = new(StringComparer.Ordinal);
        public HashSet<string> RevokedGuestIds { get; } = new(StringComparer.Ordinal);
        public HashSet<string> HandoffBypassGuestIds { get; } = new(StringComparer.Ordinal);
    }

    private sealed class ParticipantState
    {
        public required string Id { get; init; }
        public required string Name { get; set; }
        public int AvatarTone { get; init; }
        public DateTimeOffset JoinedAt { get; init; }
        public DateTimeOffset LastSeen { get; set; }
        public DateTimeOffset LastMessageAt { get; set; }
        public bool MicOn { get; set; }
        public bool CameraOn { get; set; }
        public bool ScreenOn { get; set; }
        public bool ScreenWithAudio { get; set; }
        public bool Speaking { get; set; }
    }
}
