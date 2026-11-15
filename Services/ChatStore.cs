using Microsoft.Data.Sqlite;
using Onda.Models;

namespace Onda.Services;

public sealed record PersistedGuestIdentity(
    string GuestId,
    string Name,
    int AvatarTone);

public sealed record PersistedRoom(
    string Id,
    string Name,
    string OwnerId,
    string OwnerName,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastActivityAt,
    DateTimeOffset? EmptySince,
    string? PasswordSalt,
    string? PasswordHash,
    int MaxParticipants);

/// <summary>
/// SQLite-backed persistence for room metadata, visit history and chat.
/// Rooms survive process restarts; empty rooms are removed after the
/// RoomService grace period.
/// </summary>
public sealed class ChatStore
{
    private readonly string _databasePath;
    private readonly string _connectionString;
    private readonly ILogger<ChatStore> _logger;

    public ChatStore(StorageOptions options, IHostEnvironment environment, ILogger<ChatStore> logger)
    {
        _logger = logger;

        var configuredPath = string.IsNullOrWhiteSpace(options.DatabasePath)
            ? Path.Combine("Data", "onda.db")
            : options.DatabasePath.Trim();

        _databasePath = Path.IsPathRooted(configuredPath)
            ? configuredPath
            : Path.Combine(environment.ContentRootPath, configuredPath);

        var directory = Path.GetDirectoryName(_databasePath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = _databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            DefaultTimeout = 5
        }.ToString();

        Initialize();
    }

    public string DatabasePath => _databasePath;

    public void InsertRoom(
        string id,
        string name,
        string ownerId,
        string ownerName,
        DateTimeOffset createdAt,
        string? passwordSalt,
        string? passwordHash,
        DateTimeOffset? emptySince,
        int maxParticipants)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO rooms (
                id, name, owner_id, owner_name, created_at_ms, last_activity_ms,
                password_salt, password_hash, empty_since_ms, max_participants
            )
            VALUES (
                $id, $name, $ownerId, $ownerName, $createdAt, $lastActivity,
                $passwordSalt, $passwordHash, $emptySince, $maxParticipants
            );
            """;
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$ownerId", ownerId);
        command.Parameters.AddWithValue("$ownerName", ownerName);
        command.Parameters.AddWithValue("$createdAt", createdAt.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$lastActivity", createdAt.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$passwordSalt", (object?)passwordSalt ?? DBNull.Value);
        command.Parameters.AddWithValue("$passwordHash", (object?)passwordHash ?? DBNull.Value);
        command.Parameters.AddWithValue(
            "$emptySince",
            emptySince.HasValue ? emptySince.Value.ToUnixTimeMilliseconds() : DBNull.Value);
        command.Parameters.AddWithValue("$maxParticipants", maxParticipants);
        command.ExecuteNonQuery();
    }

    public PersistedGuestIdentity? GetGuestIdentity(string tokenHash)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT guest_id, name, avatar_tone
            FROM guest_identities
            WHERE token_hash = $tokenHash
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$tokenHash", tokenHash);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        return new PersistedGuestIdentity(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetInt32(2));
    }

    public void UpsertGuestIdentity(
        string tokenHash,
        string guestId,
        string name,
        int avatarTone,
        DateTimeOffset now)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO guest_identities (
                token_hash, guest_id, name, avatar_tone, updated_at_ms
            )
            VALUES ($tokenHash, $guestId, $name, $avatarTone, $updatedAt)
            ON CONFLICT(token_hash) DO UPDATE SET
                guest_id = excluded.guest_id,
                name = excluded.name,
                avatar_tone = excluded.avatar_tone,
                updated_at_ms = excluded.updated_at_ms;
            """;
        command.Parameters.AddWithValue("$tokenHash", tokenHash);
        command.Parameters.AddWithValue("$guestId", guestId);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$avatarTone", avatarTone);
        command.Parameters.AddWithValue("$updatedAt", now.ToUnixTimeMilliseconds());
        command.ExecuteNonQuery();
    }

    public void UpdateOwnerName(string roomId, string ownerName, DateTimeOffset now)    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE rooms
            SET owner_name = $ownerName, last_activity_ms = $lastActivity
            WHERE id = $id;
            """;
        command.Parameters.AddWithValue("$ownerName", ownerName);
        command.Parameters.AddWithValue("$lastActivity", now.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$id", roomId);
        command.ExecuteNonQuery();
    }

    public void UpdateOwner(string roomId, string ownerId, string ownerName, DateTimeOffset now)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE rooms
            SET owner_id = $ownerId,
                owner_name = $ownerName,
                last_activity_ms = $lastActivity
            WHERE id = $id;
            """;
        command.Parameters.AddWithValue("$ownerId", ownerId);
        command.Parameters.AddWithValue("$ownerName", ownerName);
        command.Parameters.AddWithValue("$lastActivity", now.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$id", roomId);
        command.ExecuteNonQuery();
    }

    public void UpdateRoomSettings(
        string roomId,
        string name,
        int maxParticipants,
        DateTimeOffset now)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE rooms
            SET name = $name,
                max_participants = $maxParticipants,
                last_activity_ms = $lastActivity
            WHERE id = $id;
            """;
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$maxParticipants", maxParticipants);
        command.Parameters.AddWithValue("$lastActivity", now.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$id", roomId);
        command.ExecuteNonQuery();
    }

    public RoomBanView? GetActiveBan(string roomId, string deviceId, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            return null;
        }

        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, guest_name, reason, banned_at_ms, expires_at_ms, banned_by_name,
                   device_id
            FROM room_bans
            WHERE room_id = $roomId
              AND device_id = $deviceId
              AND (expires_at_ms IS NULL OR expires_at_ms > $now)
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$roomId", roomId);
        command.Parameters.AddWithValue("$deviceId", deviceId);
        command.Parameters.AddWithValue("$now", now.ToUnixTimeMilliseconds());

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        return new RoomBanView(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(3)),
            reader.IsDBNull(4) ? null : DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(4)),
            reader.GetString(5),
            reader.GetString(6),
            reader.IsDBNull(4));
    }

    public IReadOnlyList<RoomBanView> GetBans(string roomId, DateTimeOffset now)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, guest_name, reason, banned_at_ms, expires_at_ms, banned_by_name,
                   device_id
            FROM room_bans
            WHERE room_id = $roomId
              AND (expires_at_ms IS NULL OR expires_at_ms > $now)
            ORDER BY banned_at_ms DESC;
            """;
        command.Parameters.AddWithValue("$roomId", roomId);
        command.Parameters.AddWithValue("$now", now.ToUnixTimeMilliseconds());

        var bans = new List<RoomBanView>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            bans.Add(new RoomBanView(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(3)),
                reader.IsDBNull(4) ? null : DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(4)),
                reader.GetString(5),
                reader.GetString(6),
                reader.IsDBNull(4)));
        }

        return bans;
    }

    public void UpsertBan(
        string roomId,
        string deviceId,
        string guestName,
        string reason,
        DateTimeOffset bannedAt,
        DateTimeOffset? expiresAt,
        string bannedByName)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO room_bans (
                id, room_id, device_id, guest_name, reason, banned_at_ms,
                expires_at_ms, banned_by_name
            )
            VALUES (
                $id, $roomId, $deviceId, $guestName, $reason, $bannedAt,
                $expiresAt, $bannedByName
            )
            ON CONFLICT(room_id, device_id) DO UPDATE SET
                guest_name = excluded.guest_name,
                reason = excluded.reason,
                banned_at_ms = excluded.banned_at_ms,
                expires_at_ms = excluded.expires_at_ms,
                banned_by_name = excluded.banned_by_name;
            """;
        command.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        command.Parameters.AddWithValue("$roomId", roomId);
        command.Parameters.AddWithValue("$deviceId", deviceId);
        command.Parameters.AddWithValue("$guestName", guestName);
        command.Parameters.AddWithValue("$reason", reason);
        command.Parameters.AddWithValue("$bannedAt", bannedAt.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue(
            "$expiresAt",
            expiresAt.HasValue ? expiresAt.Value.ToUnixTimeMilliseconds() : DBNull.Value);
        command.Parameters.AddWithValue("$bannedByName", bannedByName);
        command.ExecuteNonQuery();
    }

    public bool RemoveBan(string roomId, string banId)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            DELETE FROM room_bans
            WHERE room_id = $roomId AND id = $banId;
            """;
        command.Parameters.AddWithValue("$roomId", roomId);
        command.Parameters.AddWithValue("$banId", banId);
        return command.ExecuteNonQuery() > 0;
    }

    public PersistedRoom? GetRoom(string roomId)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, name, owner_id, owner_name, created_at_ms, last_activity_ms,
                   empty_since_ms, password_salt, password_hash, max_participants
            FROM rooms
            WHERE id = $id
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$id", roomId);

        using var reader = command.ExecuteReader();
        if (!reader.Read())
        {
            return null;
        }

        return new PersistedRoom(
            reader.GetString(0),
            reader.GetString(1),
            reader.GetString(2),
            reader.GetString(3),
            DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(4)),
            DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(5)),
            reader.IsDBNull(6) ? null : DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(6)),
            reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8),
            reader.IsDBNull(9) ? 0 : reader.GetInt32(9));
    }

    public int CountRooms()
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM rooms;";
        return Convert.ToInt32(command.ExecuteScalar() ?? 0);
    }

    public bool RoomExists(string roomId)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT 1 FROM rooms WHERE id = $id LIMIT 1;";
        command.Parameters.AddWithValue("$id", roomId);
        return command.ExecuteScalar() is not null;
    }

    public void SetEmptySince(string roomId, DateTimeOffset? emptySince)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE rooms
            SET empty_since_ms = $emptySince
            WHERE id = $id;
            """;
        command.Parameters.AddWithValue(
            "$emptySince",
            emptySince.HasValue ? emptySince.Value.ToUnixTimeMilliseconds() : DBNull.Value);
        command.Parameters.AddWithValue("$id", roomId);
        command.ExecuteNonQuery();
    }

    public void StartVisit(
        string roomId,
        string guestId,
        string guestName,
        int avatarTone,
        DateTimeOffset joinedAt)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO room_visits (
                id, room_id, guest_id, guest_name, avatar_tone, joined_at_ms, left_at_ms
            )
            VALUES (
                $id, $roomId, $guestId, $guestName, $avatarTone, $joinedAt, NULL
            );
            """;
        command.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        command.Parameters.AddWithValue("$roomId", roomId);
        command.Parameters.AddWithValue("$guestId", guestId);
        command.Parameters.AddWithValue("$guestName", guestName);
        command.Parameters.AddWithValue("$avatarTone", avatarTone);
        command.Parameters.AddWithValue("$joinedAt", joinedAt.ToUnixTimeMilliseconds());
        command.ExecuteNonQuery();
    }

    public void EndVisit(string roomId, string guestId, DateTimeOffset leftAt)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE room_visits
            SET left_at_ms = $leftAt
            WHERE id = (
                SELECT id
                FROM room_visits
                WHERE room_id = $roomId
                  AND guest_id = $guestId
                  AND left_at_ms IS NULL
                ORDER BY joined_at_ms DESC
                LIMIT 1
            );
            """;
        command.Parameters.AddWithValue("$leftAt", leftAt.ToUnixTimeMilliseconds());
        command.Parameters.AddWithValue("$roomId", roomId);
        command.Parameters.AddWithValue("$guestId", guestId);
        command.ExecuteNonQuery();
    }

    public IReadOnlyList<string> DeleteExpiredEmptyRooms(DateTimeOffset cutoff)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        var ids = new List<string>();
        using (var delete = connection.CreateCommand())
        {
            delete.Transaction = transaction;
            // RETURNING makes the check-and-delete atomic with respect to a
            // concurrent join that clears empty_since_ms.
            delete.CommandText = """
                DELETE FROM rooms
                WHERE empty_since_ms IS NOT NULL
                  AND empty_since_ms <= $cutoff
                RETURNING id;
                """;
            delete.Parameters.AddWithValue("$cutoff", cutoff.ToUnixTimeMilliseconds());
            using var reader = delete.ExecuteReader();
            while (reader.Read())
            {
                ids.Add(reader.GetString(0));
            }
        }

        transaction.Commit();
        if (ids.Count > 0)
        {
            Checkpoint(connection);
        }

        return ids;
    }

    public void AppendMessage(
        string roomId,
        string? senderId,
        string senderName,
        string body,
        DateTimeOffset sentAt,
        bool isSystem,
        int maxMessages)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();

        using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO room_messages (
                    id, room_id, sender_id, sender_name, body, sent_at_ms, is_system
                )
                VALUES (
                    $id, $roomId, $senderId, $senderName, $body, $sentAt, $isSystem
                );
                """;
            insert.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
            insert.Parameters.AddWithValue("$roomId", roomId);
            insert.Parameters.AddWithValue("$senderId", (object?)senderId ?? DBNull.Value);
            insert.Parameters.AddWithValue("$senderName", senderName);
            insert.Parameters.AddWithValue("$body", body);
            insert.Parameters.AddWithValue("$sentAt", sentAt.ToUnixTimeMilliseconds());
            insert.Parameters.AddWithValue("$isSystem", isSystem ? 1 : 0);
            insert.ExecuteNonQuery();
        }

        if (maxMessages > 0)
        {
            using var trim = connection.CreateCommand();
            trim.Transaction = transaction;
            trim.CommandText = """
                DELETE FROM room_messages
                WHERE room_id = $roomId
                  AND rowid NOT IN (
                      SELECT rowid
                      FROM room_messages
                      WHERE room_id = $roomId
                      ORDER BY sent_at_ms DESC, rowid DESC
                      LIMIT $maxMessages
                  );
                """;
            trim.Parameters.AddWithValue("$roomId", roomId);
            trim.Parameters.AddWithValue("$maxMessages", maxMessages);
            trim.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    public IReadOnlyList<ChatMessageView> GetRecentMessages(string roomId, int maxMessages)
    {
        if (maxMessages <= 0)
        {
            return [];
        }

        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, sender_id, sender_name, body, sent_at_ms, is_system
            FROM (
                SELECT id, sender_id, sender_name, body, sent_at_ms, is_system, rowid AS sequence
                FROM room_messages
                WHERE room_id = $roomId
                ORDER BY sent_at_ms DESC, rowid DESC
                LIMIT $maxMessages
            )
            ORDER BY sent_at_ms ASC, sequence ASC;
            """;
        command.Parameters.AddWithValue("$roomId", roomId);
        command.Parameters.AddWithValue("$maxMessages", maxMessages);

        var messages = new List<ChatMessageView>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            messages.Add(new ChatMessageView(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(4)),
                reader.GetInt64(5) != 0));
        }

        return messages;
    }

    public void DeleteRoom(string roomId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();

        using (var deleteVisits = connection.CreateCommand())
        {
            deleteVisits.Transaction = transaction;
            deleteVisits.CommandText = "DELETE FROM room_visits WHERE room_id = $roomId;";
            deleteVisits.Parameters.AddWithValue("$roomId", roomId);
            deleteVisits.ExecuteNonQuery();
        }

        using (var deleteMessages = connection.CreateCommand())
        {
            deleteMessages.Transaction = transaction;
            deleteMessages.CommandText = "DELETE FROM room_messages WHERE room_id = $roomId;";
            deleteMessages.Parameters.AddWithValue("$roomId", roomId);
            deleteMessages.ExecuteNonQuery();
        }

        using (var deleteRoom = connection.CreateCommand())
        {
            deleteRoom.Transaction = transaction;
            deleteRoom.CommandText = "DELETE FROM rooms WHERE id = $roomId;";
            deleteRoom.Parameters.AddWithValue("$roomId", roomId);
            deleteRoom.ExecuteNonQuery();
        }

        transaction.Commit();

        // Force WAL content back into the main db and truncate the WAL, so a
        // closed room does not leave its messages behind in the side files.
        try
        {
            using var checkpoint = connection.CreateCommand();
            checkpoint.CommandText = "PRAGMA wal_checkpoint(TRUNCATE);";
            checkpoint.ExecuteNonQuery();
        }
        catch (SqliteException ex)
        {
            _logger.LogWarning(ex, "Could not checkpoint SQLite after deleting room {RoomCode}.", roomId);
        }
    }

    public void ClearAllRooms()
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();

        using (var deleteVisits = connection.CreateCommand())
        {
            deleteVisits.Transaction = transaction;
            deleteVisits.CommandText = "DELETE FROM room_visits;";
            deleteVisits.ExecuteNonQuery();
        }

        using (var deleteMessages = connection.CreateCommand())
        {
            deleteMessages.Transaction = transaction;
            deleteMessages.CommandText = "DELETE FROM room_messages;";
            deleteMessages.ExecuteNonQuery();
        }

        using (var deleteRooms = connection.CreateCommand())
        {
            deleteRooms.Transaction = transaction;
            deleteRooms.CommandText = "DELETE FROM rooms;";
            deleteRooms.ExecuteNonQuery();
        }

        transaction.Commit();
        Checkpoint(connection);
    }

    private void Initialize()
    {
        using var connection = OpenConnection();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=1000;";
            command.ExecuteNonQuery();
        }

        using (var schema = connection.CreateCommand())
        {
            schema.CommandText = """
                CREATE TABLE IF NOT EXISTS rooms (
                    id TEXT NOT NULL PRIMARY KEY,
                    name TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    owner_name TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    last_activity_ms INTEGER NOT NULL,
                    password_salt TEXT NULL,
                    password_hash TEXT NULL,
                    empty_since_ms INTEGER NULL,
                    max_participants INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS room_messages (
                    id TEXT NOT NULL PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    sender_id TEXT NULL,
                    sender_name TEXT NOT NULL,
                    body TEXT NOT NULL,
                    sent_at_ms INTEGER NOT NULL,
                    is_system INTEGER NOT NULL,
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS ix_room_messages_room_time
                    ON room_messages(room_id, sent_at_ms);

                CREATE TABLE IF NOT EXISTS room_visits (
                    id TEXT NOT NULL PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    guest_id TEXT NOT NULL,
                    guest_name TEXT NOT NULL,
                    avatar_tone INTEGER NOT NULL,
                    joined_at_ms INTEGER NOT NULL,
                    left_at_ms INTEGER NULL,
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS ix_room_visits_room_time
                    ON room_visits(room_id, joined_at_ms);

                CREATE INDEX IF NOT EXISTS ix_room_visits_room_guest
                    ON room_visits(room_id, guest_id, joined_at_ms);

                CREATE TABLE IF NOT EXISTS guest_identities (
                    token_hash TEXT NOT NULL PRIMARY KEY,
                    guest_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    avatar_tone INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS room_bans (
                    id TEXT NOT NULL PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    guest_name TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    banned_at_ms INTEGER NOT NULL,
                    expires_at_ms INTEGER NULL,
                    banned_by_name TEXT NOT NULL,
                    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
                    UNIQUE (room_id, device_id)
                );

                CREATE INDEX IF NOT EXISTS ix_room_bans_room_device
                    ON room_bans(room_id, device_id);
                """;
            schema.ExecuteNonQuery();
        }

        EnsureRoomColumn(connection, "empty_since_ms", "INTEGER NULL");
        EnsureRoomColumn(connection, "max_participants", "INTEGER NOT NULL DEFAULT 0");

        // This index must be created only after the column exists on databases
        // created by older versions. Creating it in the schema batch above
        // fails on those databases because CREATE TABLE IF NOT EXISTS does not
        // add new columns.
        using (var index = connection.CreateCommand())
        {
            index.CommandText = """
                CREATE INDEX IF NOT EXISTS ix_rooms_empty_since
                    ON rooms(empty_since_ms);
                """;
            index.ExecuteNonQuery();
        }

        // After a process restart no browser/native session is authoritative.
        // Give every room a fresh 30-minute grace window, while preserving an
        // already-running empty window from before the restart.
        using (var markEmpty = connection.CreateCommand())
        {
            markEmpty.CommandText = """
                UPDATE rooms
                SET empty_since_ms = $now
                WHERE empty_since_ms IS NULL;
                """;
            markEmpty.Parameters.AddWithValue(
                "$now",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            markEmpty.ExecuteNonQuery();
        }

        // Any visit left open by the previous process ended at startup.
        using (var closeVisits = connection.CreateCommand())
        {
            closeVisits.CommandText = """
                UPDATE room_visits
                SET left_at_ms = $now
                WHERE left_at_ms IS NULL;
                """;
            closeVisits.Parameters.AddWithValue(
                "$now",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            closeVisits.ExecuteNonQuery();
        }

        _logger.LogInformation(
            "SQLite persistence ready at {DatabasePath}; rooms and history are preserved.",
            _databasePath);
    }

    private void EnsureRoomColumn(SqliteConnection connection, string column, string definition)
    {
        var exists = false;
        using (var info = connection.CreateCommand())
        {
            info.CommandText = "PRAGMA table_info(rooms);";
            using var reader = info.ExecuteReader();
            while (reader.Read())
            {
                if (string.Equals(reader.GetString(1), column, StringComparison.OrdinalIgnoreCase))
                {
                    exists = true;
                    break;
                }
            }
        }

        if (!exists)
        {
            using var alter = connection.CreateCommand();
            alter.CommandText = $"ALTER TABLE rooms ADD COLUMN {column} {definition};";
            alter.ExecuteNonQuery();
        }
    }

    private void Checkpoint(SqliteConnection connection)
    {
        try
        {
            using var checkpoint = connection.CreateCommand();
            checkpoint.CommandText = "PRAGMA wal_checkpoint(TRUNCATE);";
            checkpoint.ExecuteNonQuery();
        }
        catch (SqliteException ex)
        {
            _logger.LogWarning(ex, "Could not checkpoint SQLite at {DatabasePath}.", _databasePath);
        }
    }

    private SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;";
        command.ExecuteNonQuery();
        return connection;
    }
}
