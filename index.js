const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const session = require('cookie-session')
const bodyParser = require('body-parser')
const multer = require('multer')
const mysql = require('mysql')
const ECT = require('ect')
const promisify = require('es6-promisify')

const STATIC_FOLDER = path.join(__dirname, '..', 'public')
const ICONS_FOLDER = path.join(STATIC_FOLDER, 'icons')
const AVATAR_MAX_SIZE = 1 * 1024 * 1024
const PORT = 5000

const ect = new ECT({
  root: path.join(__dirname, 'views'),
  ext : '.html',
})
const upload = multer({ dest: '/tmp' })
const app = express()

app.set('view engine', 'html')
app.engine('html', ect.render)
app.use(express.static(STATIC_FOLDER))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(session({
  name: 'session',
  keys: ['tonymoris'],
  maxAge: 360000,
}))
app.use((err, req, res, next) => {
  res.status(500).end()
})

const pool = mysql.createPool({
  connectionLimit: 20,
  host: process.env.ISUBATA_DB_HOST || 'localhost',
  port: process.env.ISUBATA_DB_PORT || '3306',
  user: process.env.ISUBATA_DB_USER || 'root',
  password: process.env.ISUBATA_DB_PASSWORD || '',
  database: 'isubata',
  charset: 'utf8mb4',
})
pool.query = promisify(pool.query, pool)

app.get('/initialize', getInitialize)
function getInitialize(req, res) {
  return pool.query('DELETE FROM user WHERE id > 1000')
    .then(() => pool.query('DELETE FROM image WHERE id > 1001'))
    .then(() => pool.query('DELETE FROM channel WHERE id > 10'))
    .then(() => pool.query('DELETE FROM message WHERE id > 10000'))
    .then(() => pool.query('DELETE FROM haveread'))
    .then(() => pool.query('UPDATE channel AS c SET c.count = (SELECT count(*) FROM message WHERE channel_id = c.id)'))
    .then(() => res.status(204).send(''))
}

function dbGetUser(conn, userId) {
  return conn.query('SELECT * FROM user WHERE id = ?', [userId])
    .then(([result]) => result)
}

function dbAddMessage(conn, channelId, userId, content) {
  return conn.query('INSERT INTO message (channel_id, user_id, content, created_at) VALUES (?, ?, ?, NOW())', [channelId, userId, content])
    .then(() => conn.query('UPDATE channel SET count = count+1 WHERE id = ?', [channelId]))
}

function loginRequired(req, res, next) {
  if (!req.session.userId) {
    res.redirect(303, '/login')
    return
  }

  req.userId = req.session.userId
  return dbGetUser(pool, req.userId)
    .then(user => {
      req.user = user
      next()
    })
}

function randomString(len) {
  const seed = '1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let str = ''
  while (--len) {
    str += seed[~~(Math.random() * seed.length)]
  }
  return str
}

function register(conn, user, password) {
  const salt = randomString(20)
  const passDigest = crypto.createHash('sha1')
    .update(salt + password)
    .digest('hex')

  return conn.query(`INSERT INTO user (name, salt, password, display_name, avatar_icon, created_at)
    VALUES (?, ?, ?, ?, ?, NOW())`,
    [user, salt, passDigest, user, 'default.png'])
    .then(({ insertId }) => insertId)
}

app.get('/', getIndex)
function getIndex(req, res) {
  if (req.session.userId) {
    res.redirect(303, '/channel/1')
  } else {
    res.render('index', { req })
  }
}

function getChannelListInfo (conn, focusChannelId = null) {
  return conn.query('SELECT * FROM channel ORDER BY id')
    .then(channels => {
      let description = ''
      channels.forEach((channel) => {
        if (channel.id == focusChannelId) {
          description = channel.description
        }
      })

      return { channels, description }
    })
}

app.get('/channel/:channelId', loginRequired, getChannel)
function getChannel(req, res) {
  const { channelId } = req.params
  return getChannelListInfo(pool, channelId)
    .then(({ channels, description }) => {
      res.render('channel', {
        req,
        channels,
        description,
        channelId,
      })
    })
}

app.get('/register', getRegister)
function getRegister(req, res) {
  res.render('register', { req })
}

app.post('/register', postRegister)
function postRegister(req, res) {
  const { name, password } = req.body
  if (!name || !password) {
    res.status(400).end()
    return
  }

  return register(pool, name, password)
    .then(userId => {
      req.session.userId = userId
      res.redirect(303, '/')
    })
    .catch(e => {
      res.status(409).end()
    })
}

app.get('/login', getLogin)
function getLogin(req, res) {
  res.render('login', { req })
}

app.post('/login', postLogin)
function postLogin(req, res) {
  return pool.query('SELECT * FROM user WHERE name = ?', [req.body.name])
    .then(([row]) => {
      if (!row) {
        res.status(403).end()
        return
      }

      const { salt, password, id } = row
      const shasum = crypto.createHash('sha1')
      shasum.update(salt + req.body.password)
      const digest = shasum.digest('hex')
      if (password === digest) {
        req.session.userId = id
        res.redirect(303, '/')
      } else {
        res.status(403).end()
      }
    })
}

app.get('/logout', getLogout)
function getLogout(req, res) {
  req.session = null
  res.redirect(303, '/')
}

app.post('/message', postMessage)
function postMessage(req, res) {
  const { userId } = req.session

  return dbGetUser(pool, userId)
    .then(user => {
      const { channel_id, message } = req.body
      if (!user || !channel_id || !message) {
        res.status(403).end()
        return
      }

      return dbAddMessage(pool, channel_id, userId, message)
        .then(() => res.status(204).end(''))
    })
}

function zeroPadd (num, digit) {
  return ('0'.repeat(digit) + num).slice(-digit)
}

function formatDate (dateStr) {
  const d = new Date(dateStr)
  const datePart = [d.getFullYear(), zeroPadd(d.getMonth() + 1, 2), zeroPadd(d.getDate(), 2)].join('/')
  const timePart = [zeroPadd(d.getHours(), 2), zeroPadd(d.getMinutes(), 2), zeroPadd(d.getSeconds(), 2)].join(':')
  return datePart + ' ' + timePart
}

app.get('/message', getMessage)
function getMessage(req, res) {
  const { userId } = req.session
  if (!userId) {
    res.status(403).end()
    return
  }

  const { channel_id, last_message_id } = req.query;
  const sql = `
SELECT 
  message.id as message_id, message.created_at as message_created_at, message.content as message_content, 
  u.name as user_name, u.display_name, u.avatar_icon 
FROM 
  message 
LEFT JOIN 
  user as u
ON 
  message.user_id = u.id
WHERE 
  message.id > ${last_message_id} 
AND 
  channel_id = ${channel_id}
ORDER BY message.id DESC LIMIT 100`;

  return pool.query(sql)
    .then((rows)=>{
      const response = [];
      let p = Promise.resolve();

      rows.forEach((row, i) => {
        const r = {};
        r.id = row.message_id;
        r.date = formatDate(row.message_created_at)
        r.content = row.message_content;
        r.user = {
          name: row.user_name,
          display_name: row.display_name,
          avatar_icona: row.avatar_icon,
        };
        response[i] = r;
      });
      return p.then(() => {
        response.reverse()
        const maxMessageId = rows.length ? Math.max(...rows.map(r => r.message_id)) : 0
        return pool.query(`INSERT INTO haveread (user_id, channel_id, message_id, updated_at, created_at)
          VALUES (?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE message_id = ?, updated_at = NOW()`,
          [userId, channel_id, maxMessageId, maxMessageId])
          .then(() => res.json(response))
      })
    })
}

function sleep (seconds) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, seconds * 1000)
  })
}

app.get('/fetch', fetchUnread)
function fetchUnread(req, res) {
  const { userId } = req.session
  if (!userId) {
    res.status(403).end()
    return
  }

  const messagesCnt = {}
  return Promise.resolve()
    .then(() => pool.query('SELECT id as channelId, count as cnt FROM channel'))
    .then(rows => {
      rows.forEach(row => {
        const channelId = row.channelId
        const cnt       = row.cnt
        messagesCnt[channelId] = cnt
      })
      return messagesCnt
    }).then((messagesCnt) => {
      return Promise.resolve()
        .then(() => pool.query('SELECT channel.id as channelId, haveread.message_id as messageId FROM channel LEFT JOIN' +
          ' haveread ON channel.id = haveread.channel_id AND haveread.user_id = ?', [userId]))
        .then(rows => {
          const results = []
          let p = Promise.resolve()

          rows.forEach(row => {
            const channelId = row.channelId
            const messageId = row.messageId

            p = p.then(() => {
              if (messageId) {
                return pool.query('SELECT COUNT(*) as cnt FROM message WHERE channel_id = ? AND ? < id', [channelId, messageId])
              } else {
                return [{ cnt: messagesCnt[channelId] }]
              }
            }).then(([row3]) => {
              const r = {}
              r.channel_id = channelId
              r.unread = row3.cnt
              results.push(r)
            })
          });

          return p.then(() => results)
        })
        .then(results => res.json(results))
    })
}

app.get('/history/:channelId', loginRequired, getHistory)
function getHistory(req, res) {
  const { channelId } = req.params
  let page = parseInt(req.query.page || '1');

  const N = 20;
  return pool.query('SELECT count as cnt FROM channel WHERE id = ?', [channelId])
    .then(([row2]) => {
      const cnt = row2.cnt
      const maxPage = Math.max(Math.ceil(cnt / N), 1)

      if (isNaN(page) || page < 1 || page > maxPage) {
        res.status(400).end();
        return
      }
      const sql = `
SELECT 
  message.id as message_id, message.created_at as message_created_at, message.content as message_content, 
  u.name as user_name, u.display_name, u.avatar_icon 
FROM 
  message 
LEFT JOIN 
  user as u 
ON 
  message.user_id = u.id 
WHERE 
  channel_id = ${channelId} 
ORDER BY message.id DESC LIMIT ${N} OFFSET ${(page - 1) * N}
      `;
      return pool.query(sql)
        .then((rows) => {
          const messages = [];
          rows.forEach((row) => {
            const r = {};
            r.id = row.message_id;
            r.user = {
              name: row.user_name,
              display_name: row.display_name,
              avatar_icon: row.avatar_icon,
            };
            r.date = formatDate(row.message_created_at)
            r.content = row.message_content;

            messages.push(r);
          });

          return Promise.resolve()
            .then(() => {
              messages.reverse();
              return getChannelListInfo(pool, channelId)
                .then(({ channels, description }) => {
                  res.render('history', {
                    req, channels, channelId, messages, maxPage, page,
                  })
                })
            })
        })
    })
}

app.get('/profile/:userName', loginRequired, getProfile)
function getProfile(req, res) {
  const { userName } = req.params
  return getChannelListInfo(pool)
    .then(({ channels }) => {
      return pool.query('SELECT * FROM user WHERE name = ?', [userName])
        .then(([user]) => {
          if (!user) {
            res.status(404).end()
            return
          }

          const selfProfile = req.user.id == user.id
          return res.render('profile', { req, channels, user, selfProfile })
        })
    })
}

app.get('/add_channel', loginRequired, getAddChannel)
function getAddChannel(req, res) {
  return getChannelListInfo(pool)
    .then(({ channels }) => {
      res.render('add_channel', { req, channels })
    })
}

app.post('/add_channel', loginRequired, postAddChannel)
function postAddChannel(req, res) {
  const { name, description } = req.body
  if (!name || !description) {
    res.status(400).end()
    return
  }

  return pool.query('INSERT INTO channel (name, count, description, updated_at, created_at) VALUES (?, 0, ?, NOW(), NOW())', [name, description])
    .then(({ insertId }) => {
      res.redirect(303, '/channel/' + insertId)
    })
}

app.post('/profile', loginRequired, upload.single('avatar_icon'), postProfile)
function postProfile(req, res) {
  const { userId } = req.session
  if (!userId) {
    res.status(403).end()
    return
  }

  return dbGetUser(pool, userId)
    .then(user => {
      if (!user) {
        res.status(403).end()
        return
      }

      const { display_name } = req.body
      const avatar_icon = req.file
      let avatarName, avatarData;

        Promise.resolve()
            .then(()=>{
                return new Promise((resolve, reject)=>{
                    if(avatar_icon && avatar_icon.originalname) {
                        const ext = path.extname(avatar_icon.originalname) || ''
                        if (!['.jpg', '.jpeg', '.png', '.gif'].includes(ext) || avatar_icon.size > AVATAR_MAX_SIZE) {
                            reject();
                        }else{
                            const data = fs.readFileSync(avatar_icon.path)
                            const shasum = crypto.createHash('sha1')
                            shasum.update(data)
                            const digest = shasum.digest('hex')

                            avatarName = digest + (ext ? `${ext}` : '')
                            avatarData = data;

                            resolve();
                        }

                    } else {
                        resolve();
                    }
                })
            })
            .then(()=>{
                const promiseList = [];
                if (avatarName && avatarData) {
                    promiseList.push(writeIcon(avatarName, avatarData));
                    promiseList.push(pool.query('UPDATE user SET avatar_icon = ? WHERE id = ?', [avatarName, userId]))
                }
                if (display_name) {
                    promiseList.push(pool.query('UPDATE user SET display_name = ? WHERE id = ?', [display_name, userId]))
                }

                return Promise.all(promiseList);
            })
            .then(() => res.redirect(303, '/'))
            .catch(()=>res.status(400).end());
    })
}

/**
 * アイコンファイルを public/iconsフォルダに書き込むPromiseを返却します。
 *
 * @param name
 * @param data
 * @return {Promise}
 */
function writeIcon(name, data) {
    return new Promise((resolve, reject) => {
        fs.writeFile(`${ICONS_FOLDER}/${name}`, data, function (err) {
            if (err) {
                console.error(err);
                reject();
            } else {
                resolve();
            }
        });
    });
}


function ext2mime(ext) {
  switch(ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    default:
      return ''
  }
}

app.get('/icons/:fileName', getIcon)

function getIcon(req, res) {
    const {fileName} = req.params
    const ext = path.extname(fileName) || '';
    const mime = ext2mime(ext);

    return loadIconFile(fileName)
        .then((data) => {
            res.header({'Content-Type': mime}).end(data);
        })
        .catch(() => {
            res.status(404).end();
        })
}

/**
 * アイコン画像をpublic/iconsから読みこむPromiseを返す
 *
 * @param name
 * @return {Promise}
 */
function loadIconFile(name) {
    const options = {
        encoding: 'utf-8'
    };
    return new Promise((resolve, reject) => {
        fs.readFile(`${ICONS_FOLDER}/${name}`, options, function (err, data) {
            if (err) {
                reject();
            } else {
                resolve(data);
            }
        })
    })
}

app.listen(PORT, () => {
  console.log('Example app listening on port ' + PORT + '!')
})
