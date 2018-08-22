// using test database
const app = require("../app");
const request = require("supertest");
const db = require("../db");

describe("Game Tests", () => {
  const player1 = { playerName: "playerone", token: "" };
  const player2 = { playerName: "playertwo", token: "" };
  const player3 = { playerName: "playerthree", token: "" };
  const player4 = { playerName: "playerfour", token: "" };
  const player5 = { playerName: "playerfive", token: "" };
  const testpassword = "password";

  // setup and teardown of DB
  beforeEach(async () => {
    try {
      await db.query("DELETE FROM user_table");
      await db.query("DELETE FROM tables");
      await db.query("DELETE FROM users");
    } catch (e) {
      console.log(e);
    }

    await registerUser(player1);
    await loginUser(player1);

    await registerUser(player2);
    await loginUser(player2);

    await registerUser(player3);
    await loginUser(player3);

    await registerUser(player4);
    await loginUser(player4);

    await registerUser(player5);
    await loginUser(player5);
  });

  const registerUser = async player => {
    await request(app)
      .post("/api/users/register")
      .send({
        name: player.playerName,
        password: testpassword,
        password2: testpassword
      });
  };

  const loginUser = async player => {
    // login users before requests
    const res = await request(app)
      .post("/api/users/login")
      .send({
        name: player.playerName,
        password: testpassword
      });

    player.token = res.body.token;
  };

  test("Guest cannot create a new game", async () => {
    expect.assertions(1);

    const res = await request(app)
      .post("/api/game")
      .send();

    // check to see if response is unauthorized
    expect(res.statusCode).toBe(401);
  });

  const joinGame = async player => {
    return await request(app)
      .post("/api/game")
      .set("Authorization", player.token)
      .send();
  };

  test("User logs in, gets seated at a table", async () => {
    expect.assertions(5);

    const res = await joinGame(player1);

    // check to see if response is error. User sees waiting warning if first at table
    expect(res.statusCode).toBe(400);
    expect(res.body.players).toEqual("Not enough players");

    // If I am the first player at a table, I see a sign saying that the table is waiting for more players
    // The state of the game in the DB is 'waiting'
    // A game cannot be marked as started without the minimum number of players
    const dbRes = await db.query("SELECT status from tables");
    expect(dbRes.rows[0].status).toEqual("waiting");

    // Second login with same player to check that user cannot sit at same table twice
    await joinGame(player1);

    const dbres1 = await db.query(
      "SELECT username from user_table INNER JOIN users on users.id = user_table.player_id WHERE users.username =$1",
      [player1.playerName]
    );
    expect(dbres1.rows[0].username).toEqual(player1.playerName);

    // User cannot sit at same table twice
    expect(dbres1.rows.length).toBe(1);
  });

  // I can see other player's info once I join a table. I cannot see their cards.
  test("User can see basic info about other players", async () => {
    expect.assertions(2);
    await joinGame(player1);

    const res = await joinGame(player2);

    // I can see my(p2) name
    expect(
      res.body.players.find(player => player.username === player2.playerName)
        .username
    ).toEqual(player2.playerName);

    const otherPlayer = res.body.players.find(
      player => player.username === player1.playerName
    );

    // I can see info about the other player except his cards
    expect(otherPlayer).toEqual({
      username: player1.playerName,
      dealer: true,
      chips: 98000,
      bet: 2000,
      folded: false,
      allin: false,
      talked: false,
      cards: null,
      isBigBlind: true,
      isSmallBlind: false,
      currentplayer: false
    });
  });

  const playersJoinGame = async numplayers => {
    let res;
    switch (numplayers) {
      case 2:
        res = await joinGame(player2);
        break;
      case 3:
        await joinGame(player2);
        res = await joinGame(player3);
      case 4:
        await joinGame(player2);
        await joinGame(player3);
        res = await joinGame(player4);
      case 5:
        await joinGame(player2);
        await joinGame(player3);
        await joinGame(player4);
        res = await joinGame(player5);
      default:
        break;
    }

    return res;
  };
  // A game is marked as 'started' once the minimum number of players arrive
  test("Minimum players arrive", async () => {
    expect.assertions(3);

    // login minimum number of players and have them join a game
    await joinGame(player1);
    const dbRes0 = await db.query("select minplayers from tables");
    const minplayers = dbRes0.rows[0].minplayers;
    // get info of last player to arrive at table
    const res = await playersJoinGame(minplayers);

    // last player joining game should get status of 200
    expect(res.statusCode).toBe(200);

    // check that there are only minimum number of players at the table
    const dbRes1 = await db.query("SELECT count(player_id) from user_table");
    expect(parseInt(parseInt(dbRes0.rows[0].minplayers))).toBe(
      parseInt(dbRes1.rows[0].count)
    );

    // check that the status has changed to "started"
    const dbRes2 = await db.query("SELECT status from tables");
    expect(dbRes2.rows[0].status).toEqual("started");
  });

  test("Game start", async () => {
    // expect.assertions(14);

    // login minimum number of players and have them join a game
    await joinGame(player1);
    const dbRes0 = await db.query("select minplayers from tables");
    const minplayers = parseInt(dbRes0.rows[0].minplayers);
    const res = await playersJoinGame(minplayers);
    // get deck after min players have joined
    const dbRes = await db.query("select minplayers, deck from tables");

    const numCardsPopped = minplayers * 2;
    // Once a game starts, cards are shuffled and distributed, balance cards are placed in a deck
    // deck should have 52 minus number of cards held in hand
    const deck = dbRes.rows[0].deck;
    expect(deck.length).toBe(52 - numCardsPopped);

    // get game state from response to last person that joined the game
    const activeGame = res.body;
    // game API should not respond with entire deck
    expect(activeGame.deck).toBe(undefined);

    // check that the deck in the db doesn't have the cards held by the players
    const dbRes1 = await db.query("SELECT cards from user_table");
    const dbHands = dbRes1.rows.map(hand => hand.cards).reduce((arr, hand) => {
      return arr.concat(hand);
    }, []);
    expect(deck).not.toContain(dbHands);
    expect(deck.length + dbHands.length).toBe(52);

    // Check that two cards are distributed to each player at the table
    expect(dbHands.length).toBe(numCardsPopped);

    const game1_player1 = activeGame.players.find(
      player => player.username === player1.playerName
    );
    const game1_player2 = activeGame.players.find(
      player => player.username === player2.playerName
    );
    // check that player1's cards are not visible in response but player2's cards are since we are logged in as player2
    expect(game1_player1.cards).toBe(null);
    expect(dbHands).toContain(game1_player2.cards[0]);
    expect(dbHands).toContain(game1_player2.cards[1]);

    // First user at table is identified as dealer and everyone else should not be a dealer
    expect(game1_player1.dealer).toBe(true);
    expect(game1_player2.dealer).toBe(false);

    // First player after dealer is identified as small blind, next as big blind. So in 2 player game, p1 is dealer, p2 is sb, p1 is bb
    expect(game1_player1.isSmallBlind).toBe(false);
    expect(game1_player2.isSmallBlind).toBe(true);
    expect(game1_player1.isBigBlind).toBe(true);
    expect(game1_player2.isBigBlind).toBe(false);

    // User has chips removed for buy in
    const buyinRes = await db.query("SELECT minbuyin from tables limit 1");
    const p1bankRes = await db.query(
      "SELECT bank from users where username = $1",
      [player1.playerName]
    );
    const p2bankRes = await db.query(
      "SELECT bank from users where username = $1",
      [player2.playerName]
    );
    expect(p1bankRes.rows[0].bank).toBe(100000 - buyinRes.rows[0].minbuyin);
    expect(p2bankRes.rows[0].bank).toBe(100000 - buyinRes.rows[0].minbuyin);
    // User has blind bets forced - update bets array. Player 1 is big blind, player 2 is smallblind
    expect(game1_player1.chips).toBe(100000 - activeGame.bigblind);
    expect(game1_player2.chips).toBe(100000 - activeGame.smallblind);
    expect(game1_player1.bet).toBe(activeGame.bigblind);
    expect(game1_player2.bet).toBe(activeGame.smallblind);

    // First player is identified and highlighted   // get currentPlayer - dealer +3, else last player -> p2
    expect(game1_player2.currentplayer).toBe(true);
    expect(game1_player1.currentplayer).toBe(false);

    // check that player2's cards are not visible in response but player1's cards once we are logged in as player1
    const p1res = await joinGame(player1);

    const activeGame2 = p1res.body;
    const game2_player1 = activeGame2.players.find(
      player => player.username === player1.playerName
    );
    const game2_player2 = activeGame2.players.find(
      player => player.username === player2.playerName
    );
    expect(game2_player2.cards).toBe(null);
    expect(dbHands).toContain(game2_player1.cards[0]);
    expect(dbHands).toContain(game2_player1.cards[1]);

    // User can see list of game rules - small blind, big blind, max buy in, min buy in, min players, max players
    //User can see game information: pot, round name, betname, gamestate
    expect(activeGame2).toEqual(
      expect.objectContaining({
        smallblind: expect.any(Number),
        bigblind: expect.any(Number),
        minplayers: expect.any(Number),
        maxplayers: expect.any(Number),
        minbuyin: expect.any(Number),
        maxbuyin: expect.any(Number),
        pot: expect.any(Number),
        roundname: expect.any(String),
        betname: expect.any(String),
        status: expect.any(String)
      })
    );
  });

  // // playing poker
  // test("Game actions", async () => {
  //   // Non current user cannot check.  - p1
  //   const dbRes = await db.query("select id from tables limit 1");
  //   const uri = "/api/game/" + dbRes.rows[0].id + "/check";
  //   const res = request(app)
  //     .post(uri)
  //     .set("Authorization", player1.token)
  //     .send();

  //   // p1 is unauthorized
  //   console.log(res);
  //   expect(res.statusCode).toBe(401);
  //   expect(res.body.notallowed).toContain("Wrong user has made a move");
  //   // first player shoudl be p2, he should be allowed to check
  //   const validPlayerRes = await request(app)
  //     .post(uri)
  //     .set("Authorization", player2.token)
  //     .send();

  //   expect(validPlayerRes.statusCode).toBe(200);

  //   expect(validPlayerRes.body).toContain("Success");

  //   // Current user can check
  // });

  // once a game is started, if I join a table, I have to wait for a new round before I can get a hand of cards
  // test("User logs in, gets seated at a table", async () => {
  //   expect.assertions(3);
  // });
});
