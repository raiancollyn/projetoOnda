using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using Onda.Models;

namespace Onda.Services;

/// <summary>
/// Realtime room hub for lobby, presence, chat and WebRTC signaling.
/// Room metadata, visits and chat are persisted in SQLite. Only rooms currently
/// loaded for a session are kept in memory; empty rooms are removed after
/// EmptyRoomGrace.
/// </summary>
public sealed class RoomService
{
    public const int MaxChatMessages = 120;
    public const int MaxStoredMessages = 2000;
    public const int MaxRooms = 500;
    private const int PasswordHashIterations = 120_000;
    private const int PasswordSaltBytes = 16;
    private const int PasswordHashBytes = 32;
    private const int MaxSignalPayloadLength = 262_144;

    public static readonly TimeSpan StaleParticipantAfter = TimeSpan.FromMinutes(5);

    // The native service owns audio/video independently of the suspended WebView.
    // Keep a long lease so delayed HTTP heartbeats do not remove a live call.
    public static readonly TimeSpan NativeMediaLease = TimeSpan.FromMinutes(30);

    /// <summary>
    /// A room that becomes empty is kept in SQLite for this grace window so a
    /// reload, deploy or temporary disconnection can rejoin it. The janitor
    /// deletes the room, visits and chat after this window; a join clears the
    /// empty timestamp and cancels the cleanup.
    /// </summary>
    public static readonly TimeSpan EmptyRoomGrace = TimeSpan.FromMinutes(30);

    /// <summary>Short-lived, one-time token used to move a guest identity to the desktop app.</summary>
    public static readonly TimeSpan HandoffLifetime = TimeSpan.FromMinutes(5);

    private const string RoomCodeAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    private const int MaxHandoffTokens = 500;

    private readonly object _sync = new();
    private readonly Dictionary<string, RoomState> _rooms = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, HandoffState> _handoffs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, ModerationNoticeView>> _notices =
        new(StringComparer.OrdinalIgnoreCase);
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

    private RoomState? EnsureRoomLocked(string code)
    {
        if (_rooms.TryGetValue(code, out var loaded))
        {
            return loaded;
        }

        PersistedRoom? persisted;
        try
        {
            persisted = _chatStore.GetRoom(code);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not load room {RoomCode} from SQLite.", code);
            return null;
        }

        if (persisted is null)
        {
            return null;
        }
        var room = new RoomState
        {
            Id = persisted.Id,
            Name = persisted.Name,
            OwnerId = persisted.OwnerId,
            OwnerName = persisted.OwnerName,
            CreatedAt = persisted.CreatedAt,
            LastActivityAt = persisted.LastActivityAt,
            EmptySince = persisted.EmptySince,
            PasswordSalt = persisted.PasswordSalt,
            PasswordHash = persisted.PasswordHash,
            MaxParticipants = persisted.MaxParticipants > 0
                ? Math.Clamp(persisted.MaxParticipants, 2, MaxParticipantsPerRoom)
                : MaxParticipantsPerRoom
        };

        _rooms[room.Id] = room;
        _logger.LogInformation("Room {RoomCode} loaded from SQLite.", room.Id);
        return room;
    }

    private void PersistEmptySinceLocked(RoomState room)
    {
        try
        {
            _chatStore.SetEmptySince(room.Id, room.EmptySince);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not persist the empty state for room {RoomCode}.", room.Id);
        }
    }

    private void StartVisitLocked(RoomState room, ParticipantState participant)
    {
        try
        {
            _chatStore.StartVisit(
                room.Id,
                participant.Id,
                participant.Name,
                participant.AvatarTone,
                participant.JoinedAt);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not persist the visit to room {RoomCode}.", room.Id);
        }
    }

    private void EndVisitLocked(RoomState room, string guestId, DateTimeOffset leftAt)
    {
        try
        {
            _chatStore.EndVisit(room.Id, guestId, leftAt);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not persist the exit from room {RoomCode}.", room.Id);
        }
    }


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
            if (_rooms.Count >= MaxRooms || _chatStore.CountRooms() >= MaxRooms)
            {
                var expired = _chatStore.DeleteExpiredEmptyRooms(now - EmptyRoomGrace);
                foreach (var expiredId in expired)
                {
                    _rooms.Remove(expiredId);
                }

                if (_chatStore.CountRooms() >= MaxRooms)
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
                PasswordHash = passwordHash,
                MaxParticipants = MaxParticipantsPerRoom
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
                    room.PasswordHash,
                    room.EmptySince,
                    room.MaxParticipants);
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
            var room = EnsureRoomLocked(code);
            if (room is null)
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
                IsFull: !isParticipant && room.Participants.Count >= room.MaxParticipants,                IsOwner: isOwner,
                ParticipantCount: room.Participants.Count,
                MaxParticipants: room.MaxParticipants,
                OwnerName: room.OwnerName);
        }
    }

    /// <summary>Checks whether a room still exists without joining it.</summary>
    public bool RoomExists(string? rawCode)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return false;
        }

        lock (_sync)
        {
            return EnsureRoomLocked(code) is not null;
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

            var room = EnsureRoomLocked(code);
            if (room is null)
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

            var room = EnsureRoomLocked(code);
            if (room is null ||
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
            EndVisitLocked(room, handoff.GuestId, now);
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

            PersistEmptySinceLocked(room);
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
            var room = EnsureRoomLocked(code);
            return room is null ? null : ToViewLocked(room);
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

    public RoomBanView? GetActiveBan(string? rawCode, string? deviceId)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        var normalizedDeviceId = NormalizeDeviceId(deviceId);
        if (code is null || string.IsNullOrEmpty(normalizedDeviceId))
        {
            return null;
        }

        lock (_sync)
        {
            var room = EnsureRoomLocked(code);
            if (room is null)
            {
                return null;
            }

            try
            {
                return _chatStore.GetActiveBan(room.Id, normalizedDeviceId, _time.GetUtcNow());
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not check ban for room {RoomCode}.", code);
                return null;
            }
        }
    }

    public JoinRoomResult JoinRoom(        string? rawCode,
        string guestId,
        int avatarTone,
        string? guestName,
        string? password,
        string? deviceId = null)
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
        var changed = false;
        var chatChanged = false;
        var now = _time.GetUtcNow();

        lock (_sync)
        {
            var room = EnsureRoomLocked(code);
            if (room is null)
            {
                return new JoinRoomResult(JoinRoomStatus.NotFound, "Essa sala não existe mais.", null);
            }

            var normalizedDeviceId = NormalizeDeviceId(deviceId);
            if (!string.IsNullOrEmpty(normalizedDeviceId))
            {
                var ban = _chatStore.GetActiveBan(room.Id, normalizedDeviceId, now);
                if (ban is not null)
                {
                    return new JoinRoomResult(
                        JoinRoomStatus.Banned,
                        string.IsNullOrWhiteSpace(ban.Reason)
                            ? "Você foi banido desta sala."
                            : $"Você foi banido desta sala: {ban.Reason}",
                        null,
                        ban);
                }
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
                if (!string.IsNullOrEmpty(normalizedDeviceId))
                {
                    existing.DeviceId = normalizedDeviceId;
                }
                if (string.Equals(room.OwnerId, guestId, StringComparison.Ordinal))
                {
                    room.OwnerName = normalizedName;
                    if (nameChanged)
                    {
                        PersistOwnerNameLocked(room, normalizedName, now);
                    }
                }

                room.LastActivityAt = now;
                var wasEmpty = room.EmptySince is not null;
                if (wasEmpty)
                {
                    room.EmptySince = null;
                    PersistEmptySinceLocked(room);
                }
                changed = nameChanged || wasEmpty;
                ClearNoticeLocked(room.Id, guestId);
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
                if (room.Participants.Count >= room.MaxParticipants)
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
                        LastSeen = now,
                        DeviceId = normalizedDeviceId
                    };

                    room.EmptySince = null;
                    PersistEmptySinceLocked(room);
                    StartVisitLocked(room, room.Participants[guestId]);
                    chatChanged = AddSystemMessageLocked(room, $"{normalizedName} entrou na sala.");
                    ClearNoticeLocked(room.Id, guestId);
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

        if (changed)
        {
            RaiseRoomChanged(code);
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
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            var room = EnsureRoomLocked(code);
            if (room is null)
            {
                return;
            }

            if (room.Participants.Remove(guestId, out var participant))
            {
                EndVisitLocked(room, guestId, now);
                room.LastActivityAt = now;
                if (room.Participants.Count == 0)
                {
                    room.EmptySince = now;
                    changed = true;
                }
                else if (room.EmptySince is not null)
                {
                    room.EmptySince = null;
                    changed = true;
                }

                PersistEmptySinceLocked(room);
                chatChanged = AddSystemMessageLocked(room, $"{participant.Name} saiu da sala.");
                changed = true;
            }
        }

        if (changed)
        {
            RaiseRoomChanged(code);
            RaiseLobbyChanged();
        }

        if (chatChanged)
        {
            RaiseChatChanged(code);
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

            var punished = participant.PunishedUntil is { } until && until > _time.GetUtcNow();
            micOn = micOn && !participant.MicBlocked && !punished;
            cameraOn = cameraOn && !participant.CameraBlocked && !punished;
            screenOn = screenOn && !participant.ScreenBlocked && !punished;
            screenWithAudio = screenOn && screenWithAudio;

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
            if (participant.NativeMediaActiveUntil is not null)
            {
                participant.NativeMediaActiveUntil = participant.LastSeen.Add(NativeMediaLease);
            }
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

            if (participant.ChatBlocked)
            {
                error = "O administrador bloqueou o chat para você.";
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
                    MaxStoredMessages);
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

    /// <summary>
    /// Keeps a participant present while the native call service is publishing audio.
    /// The lease is longer than the normal stale window so a suspended WebView or a
    /// temporary network handover does not remove someone whose microphone is still live.
    /// </summary>
    public void TouchNativeMedia(string? rawCode, string guestId, string? rawName, int avatarTone)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null || string.IsNullOrWhiteSpace(guestId))
        {
            return;
        }

        var name = string.IsNullOrWhiteSpace(rawName) ? "Convidado" : rawName.Trim();
        var now = _time.GetUtcNow();
        var changed = false;
        var chatChanged = false;

        lock (_sync)
        {
            var room = EnsureRoomLocked(code);
            if (room is null)
            {
                return;
            }

            var leaseUntil = now.Add(NativeMediaLease);
            if (room.Participants.TryGetValue(guestId, out var participant))
            {
                participant.LastSeen = now;
                participant.NativeMediaActiveUntil = leaseUntil;
                if (room.EmptySince is not null)
                {
                    room.EmptySince = null;
                    PersistEmptySinceLocked(room);
                }
                if (!string.Equals(participant.Name, name, StringComparison.Ordinal))
                {
                    participant.Name = name;
                    if (string.Equals(room.OwnerId, guestId, StringComparison.Ordinal))
                    {
                        room.OwnerName = name;
                    }
                    changed = true;
                }
            }
            else
            {
                if (room.Participants.Count >= room.MaxParticipants)
                {
                    return;
                }

                room.Participants[guestId] = new ParticipantState
                {
                    Id = guestId,
                    Name = name,
                    AvatarTone = Math.Clamp(avatarTone, 0, GuestSession.AvatarToneCount - 1),
                    JoinedAt = now,
                    LastSeen = now,
                    NativeMediaActiveUntil = leaseUntil
                };

                if (string.Equals(room.OwnerId, guestId, StringComparison.Ordinal))
                {
                    room.OwnerName = name;
                }

                room.EmptySince = null;
                PersistEmptySinceLocked(room);
                StartVisitLocked(room, room.Participants[guestId]);
                room.LastActivityAt = now;
                chatChanged = AddSystemMessageLocked(room, $"{name} entrou na sala.");
                changed = true;
            }
        }

        if (changed)
        {
            RaiseRoomChanged(code);
            RaiseLobbyChanged();
        }

        if (chatChanged)
        {
            RaiseChatChanged(code);
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
                var expiredPunishments = room.Participants.Values
                    .Where(p => p.PunishedUntil is { } until && until <= now)
                    .ToArray();
                foreach (var participant in expiredPunishments)
                {
                    participant.PunishedUntil = null;
                    if (AddSystemMessageLocked(room, $"O castigo de {participant.Name} terminou."))
                    {
                        chatChangedRooms.Add(room.Id);
                    }
                }
                if (expiredPunishments.Length > 0)
                {
                    changedRooms.Add(room.Id);
                }

                var stale = room.Participants.Values
                    .Where(p =>
                        (p.NativeMediaActiveUntil is null || p.NativeMediaActiveUntil <= now) &&
                        now - p.LastSeen > StaleParticipantAfter)
                    .ToArray();

                if (stale.Length == 0)
                {
                    continue;
                }

                foreach (var participant in stale)
                {
                    room.Participants.Remove(participant.Id);
                    EndVisitLocked(room, participant.Id, now);
                }

                room.LastActivityAt = now;
                if (room.Participants.Count == 0)
                {
                    // The last user disappeared without a clean leave. Keep the
                    // complete room/history for EmptyRoomGrace, then the janitor
                    // removes it from SQLite.
                    room.EmptySince ??= now;
                }
                else if (room.EmptySince is not null)
                {
                    room.EmptySince = null;
                }

                PersistEmptySinceLocked(room);

                foreach (var participant in stale)
                {
                    if (AddSystemMessageLocked(room, $"{participant.Name} saiu por inatividade."))
                    {
                        chatChangedRooms.Add(room.Id);
                    }
                }

                if (room.Participants.Count > 0)
                {
                    changedRooms.Add(room.Id);
                }

                lobbyChanged = true;
            }

            // This also removes persisted rooms that were never loaded into memory.
            IReadOnlyList<string> expired = [];
            try
            {
                expired = _chatStore.DeleteExpiredEmptyRooms(now - EmptyRoomGrace);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not delete expired persisted rooms.");
            }

            foreach (var roomId in expired)
            {
                _rooms.Remove(roomId);
            }

            if (expired.Count > 0)
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
                p.JoinedAt,
                p.PunishedUntil is { } until && until > _time.GetUtcNow(),
                p.PunishedUntil is { } punishedUntil && punishedUntil > _time.GetUtcNow()
                    ? punishedUntil
                    : null,
                p.MicBlocked,
                p.CameraBlocked,
                p.ScreenBlocked,
                p.ChatBlocked))
            .ToArray();

        IReadOnlyList<ChatMessageView> messages = includeMessages
            ? LoadMessages(room.Id)
            : [];

        return new RoomView(
            room.Id,
            room.Name,
            room.HasPassword,
            room.MaxParticipants,
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
    public bool SetBlock(
        string? rawCode,
        string ownerId,
        string targetId,
        string action,
        bool blocked,
        out string? error)
    {
        error = null;
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var chatChanged = false;
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.OwnerId, ownerId, StringComparison.Ordinal))
            {
                error = "Apenas o administrador da sala pode fazer isso.";
                return false;
            }

            if (!room.Participants.TryGetValue(targetId, out var target))
            {
                error = "Participante não encontrado.";
                return false;
            }

            if (string.Equals(targetId, ownerId, StringComparison.Ordinal))
            {
                error = "Você não pode moderar a si mesmo.";
                return false;
            }

            var actionKey = (action ?? string.Empty).Trim().ToLowerInvariant();
            switch (actionKey)
            {
                case "all":
                    target.MicBlocked = blocked;
                    target.CameraBlocked = blocked;
                    target.ScreenBlocked = blocked;
                    target.ChatBlocked = blocked;
                    break;
                case "mic":
                    target.MicBlocked = blocked;
                    break;
                case "camera":
                    target.CameraBlocked = blocked;
                    break;
                case "screen":
                    target.ScreenBlocked = blocked;
                    break;
                case "chat":
                    target.ChatBlocked = blocked;
                    break;
                default:
                    error = "Ação de bloqueio inválida.";
                    return false;
            }

            if (blocked)
            {
                if (actionKey is "all" or "mic")
                {
                    target.MicOn = false;
                    target.Speaking = false;
                }
                if (actionKey is "all" or "camera")
                {
                    target.CameraOn = false;
                }
                if (actionKey is "all" or "screen")
                {
                    target.ScreenOn = false;
                    target.ScreenWithAudio = false;
                }
            }

            var ownerName = room.Participants.GetValueOrDefault(ownerId)?.Name ?? room.OwnerName;
            var actionLabel = actionKey switch
            {
                "all" => "todas as ações",
                "mic" => "o microfone",
                "camera" => "a câmera",
                "screen" => "a tela",
                _ => "o chat"
            };
            var verb = blocked ? "bloqueou" : "desbloqueou";
            chatChanged = AddSystemMessageLocked(
                room,
                $"{ownerName} {verb} {actionLabel} de {target.Name}.");
            room.LastActivityAt = now;
        }

        RaiseRoomChanged(code);
        if (chatChanged)
        {
            RaiseChatChanged(code);
        }
        return true;
    }

    public bool SetPunishment(
        string? rawCode,
        string ownerId,
        string targetId,
        int? durationMinutes,
        bool remove,
        out string? error)
    {
        error = null;
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var chatChanged = false;
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.OwnerId, ownerId, StringComparison.Ordinal))
            {
                error = "Apenas o administrador da sala pode fazer isso.";
                return false;
            }

            if (!room.Participants.TryGetValue(targetId, out var target) ||
                string.Equals(targetId, ownerId, StringComparison.Ordinal))
            {
                error = "Participante inválido.";
                return false;
            }

            var ownerName = room.Participants.GetValueOrDefault(ownerId)?.Name ?? room.OwnerName;
            if (remove)
            {
                if (target.PunishedUntil is null)
                {
                    error = "Este participante não está de castigo.";
                    return false;
                }

                target.PunishedUntil = null;
                chatChanged = AddSystemMessageLocked(
                    room,
                    $"{ownerName} removeu o castigo de {target.Name}.");
            }
            else
            {
                if (durationMinutes is not { } minutes || minutes is < 1 or > 10080)
                {
                    error = "Informe um castigo entre 1 minuto e 7 dias.";
                    return false;
                }

                target.PunishedUntil = now.AddMinutes(minutes);
                target.MicOn = false;
                target.CameraOn = false;
                target.ScreenOn = false;
                target.ScreenWithAudio = false;
                target.Speaking = false;
                chatChanged = AddSystemMessageLocked(
                    room,
                    $"{ownerName} colocou {target.Name} de castigo por {FormatDuration(minutes)}.");
            }

            room.LastActivityAt = now;
        }

        RaiseRoomChanged(code);
        if (chatChanged)
        {
            RaiseChatChanged(code);
        }
        return true;
    }

    public bool KickParticipant(
        string? rawCode,
        string ownerId,
        string targetId,
        string? rawReason,
        out string? error)
    {
        error = null;
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var reason = NormalizeReason(rawReason, 300);
        var chatChanged = false;
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.OwnerId, ownerId, StringComparison.Ordinal))
            {
                error = "Apenas o administrador da sala pode fazer isso.";
                return false;
            }

            if (!room.Participants.TryGetValue(targetId, out var target) ||
                string.Equals(targetId, ownerId, StringComparison.Ordinal))
            {
                error = "Participante inválido.";
                return false;
            }

            var ownerName = room.Participants.GetValueOrDefault(ownerId)?.Name ?? room.OwnerName;
            room.Participants.Remove(targetId);
            EndVisitLocked(room, targetId, now);
            SetNoticeLocked(
                room.Id,
                targetId,
                new ModerationNoticeView("kick", reason, null, false));

            var suffix = string.IsNullOrWhiteSpace(reason) ? string.Empty : $" Motivo: {reason}";
            chatChanged = AddSystemMessageLocked(
                room,
                $"{ownerName} expulsou {target.Name}.{suffix}");
            if (room.Participants.Count == 0)
            {
                room.EmptySince = now;
                PersistEmptySinceLocked(room);
            }
            room.LastActivityAt = now;
        }

        RaiseRoomChanged(code);
        RaiseLobbyChanged();
        if (chatChanged)
        {
            RaiseChatChanged(code);
        }
        return true;
    }

    public bool BanParticipant(
        string? rawCode,
        string ownerId,
        string targetId,
        string? rawReason,
        int? durationMinutes,
        out RoomBanView? ban,
        out string? error)
    {
        ban = null;
        error = null;
        var reason = NormalizeReason(rawReason, 300);
        if (string.IsNullOrWhiteSpace(reason))
        {
            error = "Informe o motivo do banimento.";
            return false;
        }
        if (durationMinutes is { } minutes && minutes is < 1 or > 525600)
        {
            error = "A duração do banimento é inválida.";
            return false;
        }

        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var chatChanged = false;
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.OwnerId, ownerId, StringComparison.Ordinal))
            {
                error = "Apenas o administrador da sala pode fazer isso.";
                return false;
            }

            if (!room.Participants.TryGetValue(targetId, out var target) ||
                string.Equals(targetId, ownerId, StringComparison.Ordinal))
            {
                error = "Participante inválido.";
                return false;
            }

            var deviceId = string.IsNullOrWhiteSpace(target.DeviceId)
                ? $"session:{targetId}"
                : target.DeviceId;
            DateTimeOffset? expiresAt = durationMinutes is { } duration ? now.AddMinutes(duration) : null;
            var ownerName = room.Participants.GetValueOrDefault(ownerId)?.Name ?? room.OwnerName;

            try
            {
                _chatStore.UpsertBan(
                    room.Id,
                    deviceId,
                    target.Name,
                    reason,
                    now,
                    expiresAt,
                    ownerName);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not persist a ban for room {RoomCode}.", room.Id);
                error = "Não foi possível salvar o banimento.";
                return false;
            }

            ban = new RoomBanView(
                string.Empty,
                target.Name,
                reason,
                now,
                expiresAt,
                ownerName,
                deviceId,
                expiresAt is null);

            room.Participants.Remove(targetId);
            EndVisitLocked(room, targetId, now);
            SetNoticeLocked(
                room.Id,
                targetId,
                new ModerationNoticeView("ban", reason, expiresAt, expiresAt is null));

            var durationText = expiresAt is null
                ? "permanentemente"
                : $"por {FormatDuration((int)Math.Ceiling((expiresAt.Value - now).TotalMinutes))}";
            chatChanged = AddSystemMessageLocked(
                room,
                $"{ownerName} baniu {target.Name} {durationText}. Motivo: {reason}");
            if (room.Participants.Count == 0)
            {
                room.EmptySince = now;
                PersistEmptySinceLocked(room);
            }
            room.LastActivityAt = now;
        }

        RaiseRoomChanged(code);
        RaiseLobbyChanged();
        if (chatChanged)
        {
            RaiseChatChanged(code);
        }
        return true;
    }

    public IReadOnlyList<RoomBanView> GetBans(string? rawCode, string ownerId)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return [];
        }

        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.OwnerId, ownerId, StringComparison.Ordinal))
            {
                return [];
            }
        }

        try
        {
            return _chatStore.GetBans(code, _time.GetUtcNow());
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not read bans for room {RoomCode}.", code);
            return [];
        }
    }

    public bool RemoveBan(string? rawCode, string ownerId, string banId, out string? error)
    {
        error = null;
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var chatChanged = false;
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.OwnerId, ownerId, StringComparison.Ordinal))
            {
                error = "Apenas o administrador da sala pode fazer isso.";
                return false;
            }

            try
            {
                if (!_chatStore.RemoveBan(room.Id, banId))
                {
                    error = "Banimento não encontrado.";
                    return false;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not remove a ban for room {RoomCode}.", room.Id);
                error = "Não foi possível remover o banimento.";
                return false;
            }

            var ownerName = room.Participants.GetValueOrDefault(ownerId)?.Name ?? room.OwnerName;
            chatChanged = AddSystemMessageLocked(room, $"{ownerName} removeu um banimento.");
        }

        if (chatChanged)
        {
            RaiseChatChanged(code);
        }
        return true;
    }

    public bool TransferOwnership(
        string? rawCode,
        string ownerId,
        string targetId,
        out string? error)
    {
        error = null;
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var chatChanged = false;
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.OwnerId, ownerId, StringComparison.Ordinal))
            {
                error = "Apenas o administrador da sala pode fazer isso.";
                return false;
            }

            if (!room.Participants.TryGetValue(targetId, out var target) ||
                string.Equals(targetId, ownerId, StringComparison.Ordinal))
            {
                error = "Escolha outro participante para administrar a sala.";
                return false;
            }

            var previousOwnerName = room.OwnerName;
            room.OwnerId = target.Id;
            room.OwnerName = target.Name;
            PersistOwnerLocked(room, now);
            chatChanged = AddSystemMessageLocked(
                room,
                $"{previousOwnerName} passou a administração da sala para {target.Name}.");
            room.LastActivityAt = now;
        }

        RaiseRoomChanged(code);
        RaiseLobbyChanged();
        if (chatChanged)
        {
            RaiseChatChanged(code);
        }
        return true;
    }

    public bool UpdateRoomSettings(
        string? rawCode,
        string ownerId,
        string? rawName,
        int maxParticipants,
        out string? error)
    {
        error = null;
        if (!InputRules.TryNormalizeRoomName(rawName, out var name, out error))
        {
            return false;
        }
        if (maxParticipants < 2 || maxParticipants > MaxParticipantsPerRoom)
        {
            error = $"O limite deve ficar entre 2 e {MaxParticipantsPerRoom} pessoas.";
            return false;
        }

        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            error = "Sala não encontrada.";
            return false;
        }

        var chatChanged = false;
        var now = _time.GetUtcNow();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(code, out var room) ||
                !string.Equals(room.OwnerId, ownerId, StringComparison.Ordinal))
            {
                error = "Apenas o administrador da sala pode fazer isso.";
                return false;
            }

            var nameChanged = !string.Equals(room.Name, name, StringComparison.Ordinal);
            var maxChanged = room.MaxParticipants != maxParticipants;
            room.Name = name;
            room.MaxParticipants = maxParticipants;
            try
            {
                _chatStore.UpdateRoomSettings(room.Id, name, maxParticipants, now);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not update room settings for {RoomCode}.", room.Id);
                error = "Não foi possível salvar as alterações.";
                return false;
            }

            if (nameChanged)
            {
                chatChanged |= AddSystemMessageLocked(room, $"O nome da sala foi alterado para {name}.");
            }
            if (maxChanged)
            {
                chatChanged |= AddSystemMessageLocked(
                    room,
                    $"O limite da sala foi alterado para {maxParticipants} pessoas.");
            }
            room.LastActivityAt = now;
        }

        RaiseRoomChanged(code);
        RaiseLobbyChanged();
        if (chatChanged)
        {
            RaiseChatChanged(code);
        }
        return true;
    }

    public ModerationNoticeView? TakeNotice(string? rawCode, string guestId)
    {
        var code = InputRules.NormalizeRoomCode(rawCode);
        if (code is null)
        {
            return null;
        }

        lock (_sync)
        {
            if (!_notices.TryGetValue(code, out var notices) ||
                !notices.TryGetValue(guestId, out var notice))
            {
                return null;
            }

            notices.Remove(guestId);
            if (notices.Count == 0)
            {
                _notices.Remove(code);
            }
            return notice;
        }
    }

    private void SetNoticeLocked(string roomId, string guestId, ModerationNoticeView notice)
    {
        if (!_notices.TryGetValue(roomId, out var notices))
        {
            notices = new Dictionary<string, ModerationNoticeView>(StringComparer.Ordinal);
            _notices[roomId] = notices;
        }
        notices[guestId] = notice;
    }

    private void ClearNoticeLocked(string roomId, string guestId)
    {
        if (_notices.TryGetValue(roomId, out var notices))
        {
            notices.Remove(guestId);
            if (notices.Count == 0)
            {
                _notices.Remove(roomId);
            }
        }
    }

    private void PersistOwnerLocked(RoomState room, DateTimeOffset now)
    {
        try
        {
            _chatStore.UpdateOwner(room.Id, room.OwnerId, room.OwnerName, now);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not persist owner for room {RoomCode}.", room.Id);
        }
    }

    private static string NormalizeDeviceId(string? raw)
    {
        var value = (raw ?? string.Empty).Trim();
        return value.Length <= 160 ? value : value[..160];
    }

    private static string NormalizeReason(string? raw, int maxLength)
    {
        var value = (raw ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return string.Empty;
        }
        return value.Length <= maxLength ? value : value[..maxLength];
    }

    private static string FormatDuration(int minutes)
    {
        if (minutes >= 1440 && minutes % 1440 == 0)
        {
            var days = minutes / 1440;
            return days == 1 ? "1 dia" : $"{days} dias";
        }
        if (minutes >= 60 && minutes % 60 == 0)
        {
            var hours = minutes / 60;
            return hours == 1 ? "1 hora" : $"{hours} horas";
        }
        return minutes == 1 ? "1 minuto" : $"{minutes} minutos";
    }

    public IReadOnlyList<ChatMessageView> GetChatMessages(string? rawCode)    {
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
            .Select(p => new RoomPersonView(p.Name, p.AvatarTone, false))
            .ToArray();

        return new RoomSummaryView(
            room.Id,
            room.Name,
            room.HasPassword,
            room.Participants.Count,
            room.MaxParticipants,
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
                MaxStoredMessages);
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
            if (!_rooms.ContainsKey(candidate) && !_chatStore.RoomExists(candidate))
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
        public required string Name { get; set; }
        public required string OwnerId { get; set; }
        public required string OwnerName { get; set; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset LastActivityAt { get; set; }
        public DateTimeOffset? EmptySince { get; set; }
        public string? PasswordSalt { get; init; }
        public string? PasswordHash { get; init; }
        public int MaxParticipants { get; set; } = 2;
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
        public DateTimeOffset? NativeMediaActiveUntil { get; set; }
        public string DeviceId { get; set; } = string.Empty;
        public bool MicBlocked { get; set; }
        public bool CameraBlocked { get; set; }
        public bool ScreenBlocked { get; set; }
        public bool ChatBlocked { get; set; }
        public DateTimeOffset? PunishedUntil { get; set; }
    }
}
