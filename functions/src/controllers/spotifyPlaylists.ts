import { Request, Response } from 'express'
import { validationResult } from 'express-validator'
import { firestore } from 'firebase-admin/lib/firestore'
import { SyncPlaylist } from '../models/syncPlaylist'
import { Playlist } from '../types/spotify'
import { SpotifyClient } from '../utils/spotifyClient'
import Timestamp = firestore.Timestamp

export const getAllPlaylists = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { user } = req
  try {
    const spotifyClient = await new SpotifyClient(user.uid)
    const playlists: Playlist[] = await spotifyClient.getSpotifyPlaylistsRecursive(
      50,
    )
    res.send(playlists)
  } catch (e) {
    console.log(e)
    res.status(500).send(e.message)
  }
}

interface CombinePlaylistRequestBody {
  name: string
  playlistIds: string[]
  description?: string
}

/** Combine user requested playlists into one
 *
 * @param req
 * @param res
 */
export const postCombinePlaylists = async (
  req: Request,
  res: Response,
): Promise<Response> => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() })
  }
  const {
    name,
    playlistIds,
    description,
  } = req.body as CombinePlaylistRequestBody

  const spotifyClient = await new SpotifyClient(req.user.uid)
  const sourcePlaylists: Playlist[] = await Promise.all(
    playlistIds.map((playlistId) =>
      spotifyClient.getPlaylist(
        playlistId,
        'id,uri,snapshot_id,tracks.items(track(uri))',
      ),
    ),
  )

  // Parse unique tracks from changed source playlists
  const tracks = (
    await Promise.all(
      sourcePlaylists.map(
        async (playlist) =>
          await spotifyClient.getPlaylistItemsRecursive(
            playlist.id,
            100,
            0,
            'total,limit,offset,items(added_at,track(name,uri))', // NOTE total,limit,offset are required for recursive
          ),
      ),
    )
  )
    .flat()
    .map((track) => track.track.uri)
    .filter((track, index, self) => self.indexOf(track) === index) // Unique

  const destinationPlaylist = await spotifyClient.createPlaylist(
    name,
    false,
    false,
    description,
  )

  while (tracks.length > 0) {
    await spotifyClient.addItemsToPlaylist(
      destinationPlaylist.id,
      tracks.splice(0, 100),
    )
  }
  await SyncPlaylist.set(req.user.uid, {
    sourcePlaylists: sourcePlaylists.map((playlist) => ({
      id: playlist.id,
      uri: playlist.uri,
      snapshot_id: playlist.snapshot_id,
    })),
    destinationPlaylist: {
      id: destinationPlaylist.id,
      uri: destinationPlaylist.uri,
      snapshot_id: destinationPlaylist.snapshot_id,
    },
    lastSynced: Timestamp.now(),
  })

  return res.status(200).send(destinationPlaylist)
}

// NOTE: when we run sync process we pronanly want to start the OFFSET for playlist tracks near the playlist TOTAL since that will be the latest songsZ
