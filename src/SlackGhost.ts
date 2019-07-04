import { Main } from "./Main";
import { Logging, StoreEvent } from "matrix-appservice-bridge";
import * as rp from "request-promise-native";
import * as Slackdown from "Slackdown";
import { BridgedRoom } from "./BridgedRoom";

const log = Logging.get("SlackGhost");

// How long in milliseconds to cache user info lookups.
const USER_CACHE_TIMEOUT = 10 * 60 * 1000;  // 10 minutes

interface ISlackUser {
    profile?: {
        display_name?: string;
        real_name?: string;
        image_original?: string;
        image_1024?: string;
        image_512?: string;
        image_192?: string;
        image_72?: string;
        image_48?: string;
    }
}

export class SlackGhost {
    private atime?: number;
    private userInfoCache?: ISlackUser;
    private userInfoLoading?: rp.RequestPromise<{user? :ISlackUser}>;
    constructor(
        private main: Main,
        private userId?: string,
        private displayName?: string,
        private avatarUrl?: string,
        public readonly intent?: any) {
    }

    static fromEntry(main: Main, entry: any, intent: any) {
        return new SlackGhost(
            main,
            entry.id,
            entry.display_name,
            entry.avatar_url,
            intent
        );    
    }

    public toEntry() {
        return {
            id: this.userId,
            display_name: this.displayName,
            avatar_url: this.avatarUrl,
        };
    }

    public update(message: any, room: any) {
        log.info("Updating user information for " + message.user_id);
        return Promise.all([
            this.updateDisplayname(message, room).catch((e) => {
                log.error("Failed to update ghost displayname:", e);
            }),
            this.updateAvatar(message, room).catch((e) => {
                log.error("Failed to update ghost avatar:", e);
            }),
        ]);
    }

    public async getDisplayname(slackUserId: string, slackAccessToken: string) {
        const user = await this.lookupUserInfo(slackUserId, slackAccessToken);
        if (user && user.profile) {
            return user.profile.display_name || user.profile.real_name;
        }
    }

    public async updateDisplayname(message: any, room: BridgedRoom) {
        const token = room.AccessToken;
        if (!token) {
            return;
        }

        let displayName = message.user_name;

        if (!displayName) {
            displayName = await this.getDisplayname(message.user_id, token);
        }

        if (!displayName || this.displayName === displayName) {
            return; // Nothing to do.
        }

        await this.intent.setDisplayName(displayName);
        this.displayName = displayName;
        return this.main.putUserToStore(this);
    }

    public async lookupAvatarUrl(slackUserId: string, slackAccessToken: string) {
        const user = await this.lookupUserInfo(slackUserId, slackAccessToken);
        if (!user || !user.profile) return;
        const profile = user.profile;

        // Pick the original image if we can, otherwise pick the largest image
        // that is defined
        return profile.image_original ||
            profile.image_1024 || profile.image_512 || profile.image_192 ||
            profile.image_72 || profile.image_48;
    }

    public async lookupUserInfo(slackUserId: string, slackAccessToken: string) {
        if (this.userInfoCache) {
            log.debug("Using cached userInfo for", slackUserId);
            return this.userInfoCache;
        }
        if (this.userInfoLoading) {
            const response = await this.userInfoLoading;
            if (response.user) {
                return response.user;
            }
            return undefined;
        }
        log.debug("Using fresh userInfo for", slackUserId)

        this.main.incRemoteCallCounter("users.info");
        this.userInfoLoading = rp({
            uri: 'https://slack.com/api/users.info',
            qs: {
                token: slackAccessToken,
                user: slackUserId,
            },
            json: true,
        }) as rp.RequestPromise<{user? :ISlackUser}>;
        const response = await this.userInfoLoading!;
        if (!response.user || !response.user.profile) {
            log.error("Failed to get user profile", response);
            return;
        }
        this.userInfoCache = response.user;
        setTimeout(() => this.userInfoCache = undefined, USER_CACHE_TIMEOUT);
        this.userInfoLoading = undefined;
        return response.user!;
    }

    public async updateAvatar(message: any, room: BridgedRoom) {
        const token = room.AccessToken;
        if (!token) {
            return;
        }

        const avatarUrl = await this.lookupAvatarUrl(message.user_id, token);
        if (!avatarUrl || this.avatarUrl === avatarUrl) {
            return;
        }

        const match = avatarUrl.match(/\/([^\/]+)$/);
        if (!match || !match[1]) {
            return;
        }

        const shortname = match[1];

        const response = await rp({
            uri: avatarUrl,
            resolveWithFullResponse: true,
            encoding: null,
        });
        const contentUri = await this.uploadContent({
            _content: response.body,
            title: shortname,
            mimetype: response.headers["content-type"],
        });
        await this.intent.setAvatarUrl(contentUri);
        this.avatarUrl = avatarUrl;
        this.main.putUserToStore(this);
    }

    public sendText(roomId: string, text: string, slackRoomID: string, slackEventTS: number) {
        // TODO: Slack's markdown is their own thing that isn't really markdown,
        // but the only parser we have for it is slackdown. However, Matrix expects
        // a variant of markdown that is in the realm of sanity. Currently text
        // will be slack's markdown until we've got a slack -> markdown parser.

        //TODO: This is fixing plaintext mentions, but should be refactored. See issue #110
        const body = text.replace(/<https:\/\/matrix\.to\/#\/@.+:.+\|(.+)>/g, "$1");
        
        const content = {
            body,
            msgtype: "m.text",
            formatted_body: Slackdown.parse(text),
            format: "org.matrix.custom.html"
        };
        return this.sendMessage(roomId, content, slackRoomID, slackEventTS);
    }

    public async sendMessage(roomId: string, msg: any, slackRoomID: string, slackEventTS: number) {
        const matrixEvent = await this.intent.sendMessage(roomId, msg);
        this.main.incCounter("sent_messages", {side: "matrix"});

        const event = new StoreEvent(roomId, matrixEvent.event_id, slackRoomID, slackEventTS);
        const store = this.main.eventStore;
        await store.upsertEvent(event);

        return matrixEvent;
    }

    public async uploadContentFromURI(file: any, uri: any, slackAccessToken: string) {
        try {
            const buffer = await rp({
                uri: uri,
                headers: {
                    Authorization: `Bearer ${slackAccessToken}`,
                },
                encoding: null, // Because we expect a binary
            });
            file._content = buffer;
            return await this.uploadContent(file);
        } catch (reason) {
            log.error("Failed to upload content:\n%s", reason);
            throw reason;
        }
    }

    public async uploadContent(file: any) {
        const response = await this.intent.getClient().uploadContent({
            stream: new Buffer(file._content, "binary"),
            name: file.title,
            type: file.mimetype,
        });
        const content_uri = JSON.parse(response).content_uri;
        log.debug("Media uploaded to " + content_uri);
        return content_uri;
    }

    public bumpATime() {
        this.atime = Date.now() / 1000;
    }
    
    public get aTime() {
        return this.atime;
    }   
}