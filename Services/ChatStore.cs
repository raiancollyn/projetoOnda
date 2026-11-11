using Microsoft.Data.Sqlite;
using Onda.Models;

namespace Onda.Services;

/// <summary>
/// SQLite-backed persistence for room metadata and chat history.
///
/// Rooms are authoritative only while they have participants. On process
/// startup every persisted room is orphaned (browser circuits are gone), so the
/// database is cleared. Rooms are also deleted as soon as their participant
/// count reaches zero, which removes their entire chat history.
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
        string? passwordHash)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO rooms (
                id, name, owner_id, owner_name, created_at_ms, last_activity_ms,
                password_salt, password_hash
            )
            VALUES (
                $id, $name, $ownerId, $ownerName, $createdAt, $lastActivity,
                $passwordSalt, $passwordHash
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
        command.ExecuteNonQuery();
    }

    public void UpdateOwnerName(string roomId, string ownerName, DateTimeOffset now)
    {
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
                    password_hash TEXT NULL
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
                """;
            schema.ExecuteNonQuery();
        }

        ClearAllRooms();
        _logger.LogInformation("SQLite chat storage ready at {DatabasePath}. Orphaned rooms were cleared.", _databasePath);
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
